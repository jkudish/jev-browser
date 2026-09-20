// The navigation loop. Code owns control flow; Jev owns the judgments.
// Hardening pass applied per external review: stop gates run BEFORE action
// execution, the deadline is a real AbortSignal threaded through Jev, the
// typing generator, and every Playwright timeout, usage is per-run, and the
// final payload/screenshot extraction is best-effort.
import { chromium, type Browser, type Page } from "playwright";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import TurndownService from "turndown";
import * as gfm from "turndown-plugin-gfm";
import {
  buildActionSpace,
  buildCriteria,
  heuristicQuery,
  pickAlternate,
  PRICE_PER_MTOK_IN,
  RawElement,
  selectorFor,
} from "./lib.js";
import { selectOptionQuestion, stepQuestions } from "./questions.js";

const MAX_CONSOLE_EVENTS = 200;
const STATE_EXCERPT_CHARS = 1_500;

export interface NavigateOptions {
  task: string;
  startUrl: string;
  maxSteps?: number;
  maxSeconds?: number;
  allowTyping?: boolean;
  format?: "text" | "markdown" | "html" | "aria";
  maxChars?: number;
  screenshot?: "final" | "none";
  recordDir?: string;
}

export interface StepRecord {
  step: number;
  t_ms?: number; // milliseconds after run start when this step began
  proposed_action: string;
  executed_action: string | null; // null when a watcher stopped the loop before execution
  detail: string;
  recovery_reason?: string;
  action_error?: string;
  outcome: string;
  confidence: number | null;
  top_probability: number | null;
  goal_done: number;
  stuck: number;
}

export interface ConsoleEvent {
  step: number;
  type: "console_error" | "console_warning" | "page_error" | "request_failed";
  text: string;
  page: string;
}

export interface JevUsage {
  jev_calls: number;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number;
}

const DEFAULT_CAPS: Record<string, number> = {
  text: 8_000,
  markdown: 16_000,
  html: 1_000_000,
  aria: 16_000,
};

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
turndown.use(gfm.gfm);

import { askJev as askProvider, type JevProvider } from "./provider.js";

interface RunBudget {
  usage: JevUsage;
  signal: AbortSignal;
  deadlineAt: number; // performance.now() milliseconds
  // Per-run model/provider state: resolved inside navigate() and mutated only
  // by this run's askJev calls, so concurrent runs cannot report each other's
  // provider and a failed run cannot inherit values from a previous one.
  requestedModel: string;
  model: string; // model reported by the most recent Jev call
  provider: JevProvider | null;
}

async function askJev(budget: RunBudget, state: unknown, questions: Record<string, unknown>) {
  const result = await askProvider(state, questions, budget.requestedModel, budget.signal);
  budget.provider = result.provider;
  budget.model = result.model;
  budget.usage.jev_calls += 1;
  budget.usage.input_tokens += result.usage.input_tokens;
  budget.usage.output_tokens += result.usage.output_tokens;
  budget.usage.est_cost_usd = (budget.usage.input_tokens / 1e6) * PRICE_PER_MTOK_IN;
  return result.answers;
}

// ── Typing generator: provider-agnostic via the Vercel AI SDK ────────────────
function resolveGeneratorModel(): { model: Parameters<typeof generateText>[0]["model"]; label: string } | null {
  const providerEnv = process.env.JEV_BROWSER_TYPE_PROVIDER;
  const modelEnv = process.env.JEV_BROWSER_TYPE_MODEL;

  // An explicit OpenAI-compatible endpoint wins: Ollama, LM Studio, vLLM, proxies.
  const baseUrl = process.env.JEV_BROWSER_TYPE_BASE_URL;
  if (baseUrl) {
    const provider = createOpenAICompatible({
      name: "custom",
      baseURL: baseUrl,
      apiKey: process.env.JEV_BROWSER_TYPE_API_KEY ?? "",
    });
    return { model: provider(modelEnv ?? "gpt-5.6-luna"), label: "compatible-endpoint" };
  }

  const candidates: Array<{ provider: string; test: RegExp; make: (m: string) => any; defaultModel: string }> = [
    {
      provider: "openai",
      test: /^sk-/,
      make: (m) => createOpenAI({ apiKey: process.env.OPENAI_API_KEY! })(m),
      defaultModel: "gpt-5.6-luna",
    },
    {
      provider: "openrouter",
      test: /^sk-or-/,
      make: (m) =>
        createOpenAICompatible({
          name: "openrouter",
          baseURL: "https://openrouter.ai/api/v1",
          apiKey: process.env.OPENROUTER_API_KEY!,
        })(m),
      defaultModel: "google/gemini-2.5-flash-lite",
    },
    {
      provider: "anthropic",
      test: /^sk-ant-/,
      make: (m) => createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })(m),
      defaultModel: "claude-haiku-4.5",
    },
    {
      provider: "google",
      test: /^AIza/,
      make: (m) => createGoogleGenerativeAI({ apiKey: (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY)! })(m),
      defaultModel: "gemini-2.5-flash",
    },
  ];

  // Explicit provider first, then auto-detection by key shape.
  const ordered = providerEnv
    ? [...candidates.filter((c) => c.provider === providerEnv), ...candidates.filter((c) => c.provider !== providerEnv)]
    : candidates;

  for (const candidate of ordered) {
    const key =
      candidate.provider === "openai"
        ? (process.env.OPENAI_API_KEY ?? "")
        : candidate.provider === "openrouter"
          ? (process.env.OPENROUTER_API_KEY ?? "")
          : candidate.provider === "anthropic"
            ? (process.env.ANTHROPIC_API_KEY ?? "")
            : (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "");
    if (key.length > 20 && candidate.test.test(key)) {
      return { model: candidate.make(modelEnv ?? candidate.defaultModel), label: candidate.provider };
    }
  }
  return null;
}

async function generateTextToType(
  budget: RunBudget,
  task: string,
  elementDescription: string,
  url: string,
): Promise<{ text: string; via: string }> {
  const generator = resolveGeneratorModel();
  if (!generator) return { text: heuristicQuery(task), via: "keyword-heuristic" };
  try {
    const { text } = await generateText({
      model: generator.model,
      prompt: `A browser agent is performing this task: "${task}". It must type into the ${elementDescription} on ${url}. Reply with ONLY the exact text to type (for a search box: a short search query; no quotes, no explanation).`,
      maxOutputTokens: 48,
      abortSignal: budget.signal,
    });
    const cleaned = text.trim().replace(/^["']|["']$/g, "");
    if (cleaned.length === 0) throw new Error("empty generation");
    return { text: cleaned, via: generator.label };
  } catch (error) {
    if (budget.signal.aborted) throw error; // deadline/cancellation propagates
    // A bad model id or provider outage must not kill the task; degrade and say so.
    return { text: heuristicQuery(task), via: "keyword-heuristic-after-generator-error" };
  }
}

// ── Extraction: DOM-first (a11y trees under-report inputs) ───────────────────
async function extractAndStamp(page: Page, bounded: (cap: number) => number): Promise<RawElement[]> {
  return page.evaluate(
    () => {
      // Clear stamps from previous steps first: elements that dropped out of
      // the candidate list keep their old data-jev-id, which would make
      // selectors match more than one element.
      document.querySelectorAll("[data-jev-id]").forEach((el) => el.removeAttribute("data-jev-id"));
      const SEL =
        'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="searchbox"], [role="textbox"]';
      const out: any[] = [];
      for (const el of document.querySelectorAll(SEL) as NodeListOf<HTMLElement>) {
        // Cap accepted candidates AFTER filtering so hidden boilerplate at the
        // top of the DOM cannot crowd out usable controls below it.
        if (out.length >= 2000) break;
        const rects = el.getClientRects();
        if (!rects.length) continue;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const tag = el.tagName.toLowerCase();
        const roleAttr = el.getAttribute("role") || "";
        const typeAttr = (el.getAttribute("type") || "").toLowerCase();
        // Accessible-name resolution for form controls (AccName 1.2 §4.3.2):
        // aria-labelledby refs first, then aria-label, then the control's
        // associated native labels (label[for] and wrapping labels, all of
        // them, in tree order), then placeholder and title. Inputs are void
        // elements: innerText is always empty, so plain <label for> forms
        // resolve here or not at all. Every candidate is normalized before the
        // fallback chain so a blank attribute cannot suppress the rest of it.
        const norm = (s: string | null | undefined): string => (s ?? "").replace(/\s+/g, " ").trim();
        const labelledby = norm(
          (el.getAttribute("aria-labelledby") ?? "")
            .split(/\s+/)
            .map((ref) => document.getElementById(ref)?.textContent ?? "")
            .join(" "),
        );
        const nativeLabels = norm(
          Array.from((el as HTMLInputElement).labels ?? [])
            .map((l) => l.textContent ?? "")
            .join(" "),
        );
        // Search-like fields, by structure alone: input[type=search] or
        // role=searchbox. No form-membership or label-text heuristics here:
        // a plain text field that only looks like a search box is a real form
        // field and must keep type + submit, not a one-action search.
        const searchField = (tag === "input" && typeAttr === "search") || roleAttr === "searchbox";
        // Submit controls: an explicit submission affordance. A <button> with
        // no type attribute defaults to submit inside a form.
        const submitControl =
          (tag === "button" && (typeAttr === "submit" || (!el.hasAttribute("type") && el.closest("form") !== null))) ||
          (tag === "input" && typeAttr === "submit");
        // Submit button inputs carry their visible label in the value attribute
        // (HTML-AAM: after ARIA and native labels, before title); with no value
        // the browser supplies a default label, "Submit". Without this the
        // control extracts as unlabeled noise and drops out of the action space.
        const valueLabel =
          tag === "input" && typeAttr === "submit"
            ? el.getAttribute("value") || "Submit"
            : tag === "input" && typeAttr === "button"
              ? el.getAttribute("value") || ""
              : "";
        const label = norm(
          labelledby ||
            norm(el.getAttribute("aria-label")) ||
            nativeLabels ||
            norm(valueLabel) ||
            norm(el.getAttribute("placeholder")) ||
            norm(el.getAttribute("title")) ||
            norm(el.innerText) ||
            norm(el.textContent) ||
            "",
        );
        const href = tag === "a" ? el.getAttribute("href") || "" : "";
        const clickable =
          ["a", "button"].includes(tag) ||
          ["button", "link"].includes(roleAttr) ||
          ["submit", "button", "checkbox", "radio"].includes(typeAttr);
        const typeable =
          tag === "textarea" ||
          (tag === "input" && !["submit", "button", "checkbox", "radio", "file", "hidden", "range", "password"].includes(typeAttr)) ||
          ["searchbox", "textbox"].includes(roleAttr);
        // Enter submits from single-line fields (implicit form submission, or
        // the site's own Enter handler); a textarea Enter is just a newline.
        const enterSubmittable = typeable && tag !== "textarea";
        const selectable = tag === "select";
        if (!clickable && !typeable && !selectable) continue;
        const attr = `j${out.length + 1}`;
        el.setAttribute("data-jev-id", attr);
        const options =
          tag === "select"
            ? Array.from((el as unknown as HTMLSelectElement).options)
                .map((o) => (o.label || o.value || "").trim())
                .filter(Boolean)
                .slice(0, 200)
            : undefined;
        out.push({ attr, tag, role: roleAttr || tag, text: label.slice(0, 80), href, typeAttr, clickable, typeable, searchField, submitControl, enterSubmittable, selectable, options });
      }
      return out;
    });
}

interface Observables {
  url: string;
  title: string;
  textLength: number;
  scrollY: number;
  excerpt: string;
}

async function pageObservables(page: Page, bounded: (cap: number) => number): Promise<Observables> {
  const url = page.url();
  const title = await page.title().catch(() => "");
  const data = await page
    .evaluate(() => ({
      length: document.body?.innerText?.length ?? 0,
      scrollY: window.scrollY,
      excerpt: (document.body?.innerText ?? "").replace(/\s+/g, " ").slice(0, 1500),
    }))
    .catch(() => ({ length: 0, scrollY: 0, excerpt: "" }));
  return { url, title, textLength: data.length, scrollY: data.scrollY, excerpt: data.excerpt };
}

async function settle(page: Page, bounded: (cap: number) => number) {
  await page.waitForLoadState("domcontentloaded", { timeout: bounded(4_000) }).catch(() => {});
  // DOM-stability settle: two consecutive identical fingerprints mean the page
  // has stopped re-rendering, which is the signal we actually want; quiet
  // network was only ever a proxy for it, and analytics pings keep heavy sites
  // permanently noisy. Capped; a page that never settles still gets acted on.
  const deadline = performance.now() + bounded(1_500);
  let prev: string | null = null;
  while (performance.now() < deadline) {
    const fingerprint = await page
      .evaluate(
        () =>
          `${document.body?.innerText?.length ?? 0}:${document.querySelectorAll("a,button,input,select,textarea").length}`,
      )
      .catch(() => null);
    if (fingerprint !== null && fingerprint === prev) return; // DOM went quiet
    prev = fingerprint;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(400); // never settled; act anyway
}

// ── The loop ─────────────────────────────────────────────────────────────────
export async function navigate(options: NavigateOptions, externalSignal?: AbortSignal) {
  const {
    task,
    startUrl,
    maxSteps = 24,
    maxSeconds = 180,
    allowTyping = true,
    format = "text",
    screenshot = "final",
  } = options;
  const maxChars = options.maxChars ?? DEFAULT_CAPS[format];
  const started = performance.now();
  const deadlineAt = started + maxSeconds * 1000;

  // One abort source per run: the wall-clock deadline, optionally composed
  // with caller cancellation (the MCP layer forwards its signal).
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(new Error("deadline-exceeded")), maxSeconds * 1000);
  const onExternalAbort = () => controller.abort(new Error("cancelled-by-caller"));
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  if (externalSignal?.aborted) controller.abort(new Error("cancelled-by-caller"));

  // The model is resolved per run, not at import time, so importing the
  // library has no configuration side effects and env changes apply per call.
  const requestedModel = process.env.JEV_BROWSER_MODEL ?? "jev-latest";
  const budget: RunBudget = {
    usage: { jev_calls: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 },
    signal: controller.signal,
    deadlineAt,
    requestedModel,
    model: requestedModel,
    provider: null,
  };
  const remaining = () => Math.max(0, deadlineAt - performance.now());
  const bounded = (cap: number) => Math.max(250, Math.min(cap, remaining() || 250));

  const steps: StepRecord[] = [];
  const consoleEvents: ConsoleEvent[] = [];
  let consoleDropped = 0;
  const currentStep = { n: 0 };
  const extractionProblems: string[] = [];

  let browser: Browser | null = null;
  let status = "error";

  const recordEvent = (event: Omit<ConsoleEvent, "step">) => {
    if (consoleEvents.length >= MAX_CONSOLE_EVENTS) {
      consoleDropped += 1;
      return;
    }
    consoleEvents.push({ ...event, step: currentStep.n });
  };

  const attachPageObservers = (p: Page) => {
    p.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      recordEvent({ type: `console_${type}` as ConsoleEvent["type"], text: msg.text().slice(0, 300), page: p.url().slice(0, 120) });
    });
    p.on("pageerror", (err) => recordEvent({ type: "page_error", text: String(err).slice(0, 300), page: p.url().slice(0, 120) }));
    p.on("requestfailed", (req) =>
      recordEvent({
        type: "request_failed",
        text: `${req.method()} ${req.url().slice(0, 200)} ${req.failure()?.errorText ?? ""}`.slice(0, 300),
        page: p.url().slice(0, 120),
      }),
    );
  };

  try {
    browser = await chromium.launch({ headless: process.env.JEV_BROWSER_HEADED !== "1" });
    const context = await browser.newContext({
      viewport: { width: 1024, height: 640 },
      ...(options.recordDir ? { recordVideo: { dir: options.recordDir } } : {}),
    });
    // No Playwright default (30s) may ever outlive the run budget.
    context.setDefaultTimeout(8_000);
    let page = await context.newPage();
    const videoPathPromise = options.recordDir ? page.video()?.path() : undefined;
    attachPageObservers(page);
    let pendingPage: Page | null = null;
    context.on("page", (p) => {
      attachPageObservers(p); // adopted tabs keep producing diagnostics
      pendingPage = p;
    });

    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: bounded(30_000) });

    let lastExecuted: string | null = null;
    let lastOutcome: string | null = null;
    // Machine state for repeat recovery, decoupled from the display string:
    // "typed" (a fill happened but the page did not change) and "no_change"
    // (nothing observable happened) both make a repeat proposal redundant.
    let lastRedundant: "typed" | "no_change" | null = null;
    const history: Array<{ step: number; action: string; outcome: string }> = [];

    for (let step = 1; step <= maxSteps; step++) {
      currentStep.n = step;
      if (remaining() <= 0) {
        status = "timeout";
        break;
      }

      const raw = await extractAndStamp(page, bounded);
      const { elements, truncated } = buildActionSpace(raw);
      const observables = await pageObservables(page, bounded);

      // Empty action space is still judged normally: controls-only criteria
      // (scroll/back/done) plus the page excerpt. goal_done can and should
      // fire on terminal pages with no interactive elements.
      const state = {
        task,
        current_page: { url: observables.url, title: observables.title },
        page_text_excerpt: observables.excerpt,
        interactive_elements: elements.map((e) => ({ id: e.id, description: e.description })),
        element_list_truncated: truncated,
        no_interactive_elements: elements.length === 0,
        history,
      };
      const answers = await askJev(budget, state, stepQuestions(buildCriteria(elements)));
      const actionAnswer = answers.action;
      const proposed: string = actionAnswer.choice;
      const probabilities: Record<string, number> = actionAnswer.probabilities ?? {};
      const base = {
        step,
        t_ms: Math.round(performance.now() - started),
        proposed_action: proposed,
        confidence: actionAnswer.confidence ?? null,
        top_probability: probabilities[proposed] ?? null,
        goal_done: answers.goal_done.noul,
        stuck: answers.stuck.noul,
      };

      // Stop gates run BEFORE execution: a watcher that fires on the current
      // state must not be overridden by acting on that state.
      if (proposed === "done") {
        steps.push({ ...base, executed_action: null, detail: "done proposed; not executed", outcome: "agent declared done before acting" });
        status = "done";
        break;
      }
      if (answers.goal_done.noul > 0.85) {
        steps.push({ ...base, executed_action: null, detail: "goal watcher fired; proposed action not executed", outcome: "goal watcher fired before acting" });
        status = "goal_achieved";
        break;
      }
      if (answers.stuck.noul > 0.85 && step > 2) {
        steps.push({ ...base, executed_action: null, detail: "stuck watcher fired; proposed action not executed", outcome: "stuck watcher fired before acting" });
        status = "stuck";
        break;
      }

      // Repeat-no-op recovery: switch to the next-best option from the
      // distribution. No low-confidence override by design: split probability
      // across similar elements is usually several acceptable alternatives.
      let chosen = proposed;
      let recoveryReason: string | undefined;
      if (lastExecuted === proposed && lastRedundant !== null) {
        // "done" is excluded like "back": an alternate with any positive
        // probability is too weak a basis to terminate the run. Termination
        // stays with the model's own proposal and the goal/stuck watchers.
        const alternate = pickAlternate(probabilities, new Set([proposed, "done"]));
        if (alternate) {
          chosen = alternate;
          recoveryReason = "repeated action had no further effect; switched to next-best option";
        }
      }

      const element = elements.find(
        (e) =>
          chosen === `click_${e.id}` || chosen === `type_${e.id}` || chosen === `select_${e.id}` || chosen === `submit_${e.id}` || chosen === `search_${e.id}`,
      );

      let detail = chosen;
      let actionError: string | undefined;
      let typedIntoLabel: string | null = null;
      try {
        if (chosen === "back") {
          const wentBack = await page.goBack({ waitUntil: "domcontentloaded", timeout: bounded(10_000) }).catch(() => null);
          detail = wentBack ? "went back" : "no history to go back to";
        } else if (chosen === "scroll_down" || chosen === "scroll_up") {
          await page.evaluate(
            (dir) => window.scrollBy(0, dir * window.innerHeight * 0.8),
            chosen === "scroll_down" ? 1 : -1,
          );
          detail = chosen;
        } else if (!element) {
          actionError = `unknown action ${chosen}`;
        } else if (chosen.startsWith("type_")) {
          if (!allowTyping) {
            actionError = "typing disabled by caller";
          } else {
            const generated = await generateTextToType(budget, task, element.description, page.url());
            // Fill only: submitting is a separate submit_eN decision, so an
            // ordinary form is never submitted mid-task by a field fill.
            await page.fill(selectorFor(element), generated.text, { timeout: bounded(4_000) });
            detail = `typed "${generated.text}" via ${generated.via}`;
            typedIntoLabel = element.description.match(/"([^"]*)"/)?.[1] ?? element.kind;
          }
        } else if (chosen.startsWith("search_")) {
          if (!allowTyping) {
            actionError = "typing disabled by caller";
          } else {
            const generated = await generateTextToType(budget, task, element.description, page.url());
            await page.fill(selectorFor(element), generated.text, { timeout: bounded(4_000) });
            await page.press(selectorFor(element), "Enter", { timeout: bounded(4_000) });
            detail = `searched "${generated.text}" via ${generated.via}`;
            typedIntoLabel = element.description.match(/"([^"]*)"/)?.[1] ?? element.kind;
          }
        } else if (chosen.startsWith("submit_")) {
          if (element.submitVia === "click") {
            await page.click(selectorFor(element), { timeout: bounded(4_000) });
            detail = `submitted form: ${element.description}`;
          } else {
            await page.press(selectorFor(element), "Enter", { timeout: bounded(4_000) });
            detail = `submitted form: Enter on ${element.description}`;
          }
        } else if (chosen.startsWith("select_")) {
          const opts = element.options ?? [];
          if (opts.length === 0) {
            actionError = "select had no options";
          } else {
            const optionAnswer = await askJev(
              budget,
              { task, page: { url: observables.url, title: observables.title }, dropdown: element.description, options: opts },
              { option: selectOptionQuestion(element.description, opts) },
            );
            const pickedIndex = Number((optionAnswer.option.choice as string).slice(1));
            const label = opts[pickedIndex] ?? opts[0];
            await page.selectOption(selectorFor(element), { label });
            detail = `selected "${label}"`;
          }
        } else {
          await page.click(selectorFor(element), { timeout: bounded(4_000) });
          detail = element.description;
        }
      } catch (error) {
        if (controller.signal.aborted) throw error; // deadline/cancellation propagates
        actionError = (error as Error).message.slice(0, 160);
      }

      await settle(page, bounded);
      if (pendingPage) {
        page = pendingPage;
        pendingPage = null;
        await settle(page, bounded);
        detail += " (followed new tab)";
      }

      const after = await pageObservables(page, bounded);
      // Execution failures are attributed to the action, not to ambient page
      // changes that happened to occur in the same window.
      const pageUnchanged =
        !actionError &&
        after.url === observables.url &&
        after.title === observables.title &&
        Math.abs(after.textLength - observables.textLength) <= 50 &&
        Math.abs(after.scrollY - observables.scrollY) <= 40;
      const outcome = actionError
        ? "action failed"
        : after.url !== observables.url
          ? `navigated to ${after.url}`
          : after.title !== observables.title
            ? `page changed: "${after.title}"`
            : Math.abs(after.textLength - observables.textLength) > 50
              ? "page content changed"
              : Math.abs(after.scrollY - observables.scrollY) > 40
                ? "scrolled"
                : typedIntoLabel !== null
                  ? // A fill is a real effect even when nothing navigates: the
                    // field now holds text. Say so, or the stuck watcher
                    // misreads a successful type as a no-op.
                    `typed into "${typedIntoLabel}"; no visible page change`
                  : "no visible change";
      lastRedundant = pageUnchanged ? (typedIntoLabel !== null ? "typed" : "no_change") : null;

      lastExecuted = chosen;
      lastOutcome = outcome;
      history.push({ step, action: chosen, outcome });
      steps.push({
        ...base,
        executed_action: chosen,
        detail,
        recovery_reason: recoveryReason,
        action_error: actionError,
        outcome,
      });

      if (step === maxSteps) status = "max_steps";
    }

    const finalObservables = await pageObservables(page, bounded);
    let payload: { truncated: boolean; true_length: number; content: string } | null = null;
    let screenshotBase64: string | null = null;
    try {
      payload = await extractPayload(page, format, maxChars, bounded);
    } catch (error) {
      extractionProblems.push(`page payload: ${(error as Error).message.slice(0, 160)}`);
    }
    if (screenshot === "final") {
      try {
        const buffer = await page.screenshot({ type: "jpeg", quality: 70, timeout: bounded(10_000) });
        screenshotBase64 = buffer.toString("base64");
      } catch (error) {
        extractionProblems.push(`screenshot: ${(error as Error).message.slice(0, 160)}`);
      }
    }

    await browser.close().catch(() => {});
    const videoPath = (await videoPathPromise?.catch(() => undefined)) ?? null;
    return {
      status,
      video_path: videoPath,
      final_url: finalObservables.url,
      final_title: finalObservables.title,
      format,
      max_chars: maxChars,
      page: payload,
      extraction_problems: extractionProblems.length ? extractionProblems : undefined,
      steps,
      console_events: consoleEvents,
      console_events_dropped: consoleDropped,
      usage: { ...budget.usage },
      elapsed_ms: Math.round(performance.now() - started),
      model: budget.model,
      jev_provider: budget.provider,
      screenshot_base64_jpeg: screenshotBase64,
    };
  } catch (runError) {
    const aborted = controller.signal.aborted;
    status = aborted && String((runError as Error).message).includes("deadline") ? "timeout" : "error";
    return {
      status,
      error: aborted ? `aborted: ${(runError as Error).message}` : (runError as Error).message,
      steps,
      console_events: consoleEvents,
      console_events_dropped: consoleDropped,
      usage: { ...budget.usage },
      elapsed_ms: Math.round(performance.now() - started),
      model: budget.model,
      jev_provider: budget.provider,
    };
  } finally {
    clearTimeout(deadlineTimer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
    await browser?.close().catch(() => {});
  }
}

async function extractPayload(
  page: Page,
  format: string,
  maxChars: number,
  bounded: (cap: number) => number,
): Promise<{ truncated: boolean; true_length: number; content: string }> {
  let content = "";
  if (format === "html") {
    // Strip the extraction stamps so returned HTML matches the page the user
    // would see, not the instrumented one.
    content = await page.evaluate(
      () => {
        const clone = document.documentElement.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("[data-jev-id]").forEach((el) => el.removeAttribute("data-jev-id"));
        return clone.outerHTML;
      });
  } else if (format === "aria") {
    content = await page.locator("body").ariaSnapshot({ timeout: bounded(10_000) });
  } else if (format === "markdown") {
    const html = await page.evaluate(() => document.body?.innerHTML ?? "");
    content = turndown.turndown(html);
  } else {
    content = await page.evaluate(() => document.body?.innerText ?? "");
  }
  return {
    truncated: content.length > maxChars,
    true_length: content.length,
    content: content.slice(0, maxChars),
  };
}
