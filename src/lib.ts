// Pure helpers — no browser, no API, fully unit-testable.

/** Max elements offered to Jev per step. TypeSafe Choice supports up to 255 options. */
export const MAX_ELEMENTS = 240;

/** Raw interactive candidate as extracted from the page (already stamped with an attr). */
export interface RawElement {
  attr: string; // data-jev-id attribute value stamped in the page
  tag: string;
  role: string;
  text: string;
  href: string;
  typeAttr: string;
  clickable: boolean;
  typeable: boolean;
  selectable?: boolean; // native <select>
  passwordInput?: boolean; // native input[type=password], fillable on credential runs
  searchField?: boolean; // input[type=search] or role=searchbox: structurally a search box, by markup alone
  submitControl?: boolean; // button[type=submit], input[type=submit], or a type-less <button> inside a form
  enterSubmittable?: boolean; // single-line text field: Enter submits its form (or runs the site's handler)
  options?: SelectOption[]; // options for selects, with their DOM index
}

/** One native <select> option: its DOM index and (scrubbed) label. */
export interface SelectOption {
  i: number; // index in the live HTMLSelectElement.options list
  label: string;
}

/** Pruned action-space element. */
export interface PageElement {
  id: string; // e1, e2, ...
  attr: string;
  kind: "click" | "type" | "select" | "submit" | "search" | "fill_password";
  description: string;
  submitVia?: "click" | "enter"; // for kind === "submit": click the control, or press Enter on the field
  options?: SelectOption[]; // for kind === "select": the native option labels
}

const JUNK_NAMES = new Set([
  "jump up", "jump up to", "jump up to:", "jump to content", "edit", "permalink",
  "permanent link", "cite this page", "donate", "create account", "log in", "talk",
  "contributions", "view history", "read", "source", "hide", "show", "skip to content",
]);

export function isNoiseName(name: string): boolean {
  const lowered = name.trim().toLowerCase();
  if (lowered.length === 0 || lowered.length > 80) return true;
  if (JUNK_NAMES.has(lowered)) return true;
  if (/^[\d\s.,:;()[\]-]+$/.test(lowered)) return true; // citation numbers, lone brackets
  return false;
}

export function isNoiseHref(href: string): boolean {
  if (!href) return false; // buttons and inputs legitimately have no href
  if (href.startsWith("#")) return true;
  if (href.startsWith("javascript:")) return true;
  if (href.startsWith("mailto:") || href.startsWith("tel:")) return true;
  if (href.includes("action=edit")) return true;
  return false;
}

export interface BuildActionSpaceOptions {
  /** Offer fill_password actions on native password inputs. Off unless a password source is active. */
  passwordActive?: boolean;
}

/** Filter, dedupe by destination, cap, and describe the action space for one step. */
export function buildActionSpace(raw: RawElement[], opts: BuildActionSpaceOptions = {}): { elements: PageElement[]; truncated: boolean } {
  const passwordActive = opts.passwordActive === true;
  const seenHrefs = new Set<string>();
  const elements: PageElement[] = [];
  for (const el of raw) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (el.passwordInput) {
      // Only offered when a password source is active. Password inputs bypass
      // the noise-name drop: a nameless password field is still the field to
      // fill, and the label falls back to a generic one.
      if (!passwordActive) continue;
      const label = isNoiseName(el.text) ? "" : el.text.slice(0, 60);
      elements.push({
        id: `e${elements.length + 1}`,
        attr: el.attr,
        kind: "fill_password",
        description: `input "${label || "password"}" (fill with the configured password; it is never typed by a model)`,
      });
      continue;
    }
    if (isNoiseName(el.text)) continue;
    if (isNoiseHref(el.href)) continue;
    // Never offer to type into password or file inputs.
    if (el.typeable && (el.typeAttr === "password" || el.typeAttr === "file")) continue;
    if (el.href) {
      const key = el.href.split("#")[0];
      if (seenHrefs.has(key)) continue;
      seenHrefs.add(key);
    }
    if (!el.clickable && !el.typeable && !el.selectable) continue;
    // Search-like fields are stamped search_eN alone: fill and Enter in one
    // action, replacing the type/submit twins. Structural only, so a plain
    // text field that merely looks like a search box keeps type + submit and
    // can never be auto-submitted by search_eN.
    // Submit controls are offered as submit_eN, never click_eN, so a form
    // submission always appears in the trace as an explicit decision.
    const kind: "click" | "type" | "select" | "submit" | "search" = el.searchField
      ? "search"
      : el.submitControl
        ? "submit"
        : el.typeable
          ? "type"
          : el.selectable
            ? "select"
            : "click";
    const id = `e${elements.length + 1}`;
    const label = el.text.slice(0, 60);
    const hrefTail = el.href ? ` -> ${el.href.replace(/^https?:\/\//, "").slice(0, 70)}` : "";
    elements.push({
      id,
      attr: el.attr,
      kind,
      submitVia: kind === "submit" ? "click" : undefined,
      description:
        kind === "search"
          ? `${el.tag} "${label}" (type into this search box and run the search)`
          : kind === "submit"
            ? `${el.tag} "${label}" (submit the form now)`
            : kind === "type"
              ? `${el.tag} "${label}" (type without submitting)`
              : kind === "select"
                ? `${el.tag} "${label}" (dropdown; a follow-up picks the option)`
                : `${el.tag} "${label}"${hrefTail}`,
      options: kind === "select" ? (el.options ?? []) : undefined,
    });
    // Non-search single-line text fields additionally offer submit (press
    // Enter), which keeps Enter-driven flows reachable as two explicit steps:
    // type, then submit. One stamped action per entry, so ids, the
    // MAX_ELEMENTS cap, and the criteria mapping all keep their shape.
    if (kind === "type" && el.enterSubmittable && elements.length < MAX_ELEMENTS) {
      elements.push({
        id: `e${elements.length + 1}`,
        attr: el.attr,
        kind: "submit",
        submitVia: "enter",
        description: `${el.tag} "${label}" (submit the form now)`,
      });
    }
  }
  return { elements, truncated: elements.length >= MAX_ELEMENTS };
}

/** Jev Choice criteria for one step: element actions plus loop controls. */
export function buildCriteria(elements: PageElement[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const el of elements) {
    criteria[`${el.kind}_${el.id}`] = el.description;
  }
  criteria["scroll_down"] = "Scroll down one screen to reveal more of the page";
  criteria["scroll_up"] = "Scroll up one screen";
  criteria["back"] = "Go back to the previous page; this branch is wrong";
  criteria["done"] = "The task is already complete; stop here";
  return criteria;
}

export function selectorFor(el: PageElement): string {
  return `[data-jev-id="${el.attr}"]`;
}

/** Next-best action from a Choice distribution, excluding known-bad options. */
export function pickAlternate(probabilities: Record<string, number> | undefined, exclude: Set<string>): string | null {
  const ranked = Object.entries(probabilities ?? {}).sort((a, b) => b[1] - a[1]);
  for (const [option, p] of ranked) {
    // back is a judgment the recovery should not make for the agent; done is a
    // stop gate, not an executable element action (executing it would error).
    if (option === "back" || option === "done") continue;
    if (exclude.has(option)) continue;
    if (p <= 0) continue;
    return option;
  }
  return null;
}

const STOP_WORDS = new Set([
  "search", "wikipedia", "the", "a", "an", "article", "about", "for", "find", "stop", "when",
  "you", "are", "on", "it", "and", "to", "of", "called", "page", "site", "website", "navigate",
  "go", "open", "that", "this",
]);

/** Deterministic typing fallback when no small-LLM key is available. */
export function heuristicQuery(task: string): string {
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS.has(w));
  return words.slice(0, 6).join(" ");
}

/** jev-1.12 published pricing: input $0.042 per M tokens, output free. */
export const PRICE_PER_MTOK_IN = 0.042;

// ── Typing generator selection and degradation records ──────────────────────

/** Warning codes reported in the navigate() result when typing degraded. */
export type TypingWarningCode =
  | "typing_fallback_no_provider"
  | "typing_generator_empty"
  | "typing_generator_error"
  | "typing_configuration_error";

/** One structured typing-degradation record in the result's warnings array. */
export interface TypingWarning {
  code: TypingWarningCode;
  step: number;
  message: string;
  provider: string | null;
  model: string | null;
  finish_reason?: string;
  fallback?: string;
}

/** Provider error text is capped hard: warnings travel inside result JSON. */
export const TYPING_WARNING_MESSAGE_MAX = 200;

/** Build one TypingWarning; optional fields stay absent, not null, when unset. */
export function typingWarning(
  code: TypingWarningCode,
  step: number,
  fields: { message: string; provider: string | null; model: string | null; finishReason?: string; fallback?: string },
): TypingWarning {
  const warning: TypingWarning = {
    code,
    step,
    message: fields.message.slice(0, TYPING_WARNING_MESSAGE_MAX),
    provider: fields.provider,
    model: fields.model,
  };
  if (fields.finishReason !== undefined) warning.finish_reason = fields.finishReason;
  if (fields.fallback !== undefined) warning.fallback = fields.fallback;
  return warning;
}

/** One named typing provider, as auto-detectable by key shape. */
export interface TypingCandidateSpec {
  provider: "openai" | "openrouter" | "anthropic" | "google";
  keyEnv: string[]; // env vars that may hold the key; first defined wins
  keyLabel: string; // human key-shape description for error messages
  keyPattern: RegExp;
  defaultModel: string;
}

/** Named typing providers in auto-detection order. */
export const TYPING_CANDIDATES: TypingCandidateSpec[] = [
  { provider: "openai", keyEnv: ["OPENAI_API_KEY"], keyLabel: "an sk- key", keyPattern: /^sk-/, defaultModel: "gpt-5.6-luna" },
  { provider: "openrouter", keyEnv: ["OPENROUTER_API_KEY"], keyLabel: "an sk-or- key", keyPattern: /^sk-or-/, defaultModel: "google/gemini-2.5-flash-lite" },
  { provider: "anthropic", keyEnv: ["ANTHROPIC_API_KEY"], keyLabel: "an sk-ant- key", keyPattern: /^sk-ant-/, defaultModel: "claude-haiku-4.5" },
  { provider: "google", keyEnv: ["GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"], keyLabel: "an AIza key", keyPattern: /^AIza/, defaultModel: "gemini-2.5-flash" },
];

/** Resolved typing configuration, before any provider client is built. */
export interface TypingSelection {
  provider: "openai" | "openrouter" | "anthropic" | "google" | "compatible-endpoint";
  modelId: string;
  /** JEV_BROWSER_TYPE_BASE_URL: a custom OpenAI-compatible endpoint on its own, or the endpoint of the explicitly selected provider. */
  baseUrl?: string;
}

function envKey(env: NodeJS.ProcessEnv, names: string[]): string {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) return value;
  }
  return "";
}

/**
 * Resolve the typing generator configuration from an env record. Pure.
 *
 * - JEV_BROWSER_TYPE_PROVIDER, when set, selects ONLY that provider: an
 *   unknown value, or a missing or malformed key for it, throws, because the
 *   run must fail up front instead of silently using another provider.
 * - JEV_BROWSER_TYPE_BASE_URL selects a custom OpenAI-compatible endpoint on
 *   its own, or becomes the endpoint of the explicitly selected provider.
 * - With neither set, auto-detection picks the first candidate whose key is
 *   present and shape-valid, in TYPING_CANDIDATES order.
 * - Returns null when nothing is configured.
 */
export function resolveTypingSelection(env: NodeJS.ProcessEnv): TypingSelection | null {
  const modelEnv = env.JEV_BROWSER_TYPE_MODEL?.trim() || undefined;
  const baseUrl = env.JEV_BROWSER_TYPE_BASE_URL?.trim() || undefined;
  const providerEnv = env.JEV_BROWSER_TYPE_PROVIDER?.trim().toLowerCase() || undefined;

  if (baseUrl) {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("JEV_BROWSER_TYPE_BASE_URL must be a valid absolute http(s) URL, e.g. http://localhost:11434/v1");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("JEV_BROWSER_TYPE_BASE_URL must be an http(s) URL");
    }
  }

  if (providerEnv) {
    const candidate = TYPING_CANDIDATES.find((c) => c.provider === providerEnv);
    if (!candidate) {
      throw new Error(
        `JEV_BROWSER_TYPE_PROVIDER "${providerEnv}" is not a known typing provider; expected one of ${TYPING_CANDIDATES.map((c) => c.provider).join(", ")}`,
      );
    }
    const key = envKey(env, candidate.keyEnv);
    if (key.length <= 20 || !candidate.keyPattern.test(key)) {
      throw new Error(
        `JEV_BROWSER_TYPE_PROVIDER=${candidate.provider} requires ${candidate.keyEnv.join(" or ")} to be set to a valid key (${candidate.keyLabel}); no other typing provider will be tried`,
      );
    }
    return { provider: candidate.provider, modelId: modelEnv ?? candidate.defaultModel, baseUrl };
  }

  if (baseUrl) {
    return { provider: "compatible-endpoint", modelId: modelEnv ?? "gpt-5.6-luna", baseUrl };
  }

  for (const candidate of TYPING_CANDIDATES) {
    const key = envKey(env, candidate.keyEnv);
    if (key.length > 20 && candidate.keyPattern.test(key)) {
      return { provider: candidate.provider, modelId: modelEnv ?? candidate.defaultModel };
    }
  }
  return null;
}

/**
 * Short, body-free summary of a typing-generator error. Provider response
 * bodies and JSON-ish blobs are stripped wholesale: warnings are serialized
 * into result JSON and must never carry raw provider payloads.
 */
export function summarizeTypingError(error: unknown): string {
  const e = error as { name?: unknown; message?: unknown; status?: unknown; statusCode?: unknown } | null;
  const name = typeof e?.name === "string" && e.name.length > 0 ? e.name : "Error";
  const status = typeof e?.status === "number" ? e.status : typeof e?.statusCode === "number" ? e.statusCode : null;
  let message = String(e?.message ?? error ?? "unknown typing error");
  message = message.replace(/ResponseBody[\s\S]*$/i, "");
  const bodyStart = message.search(/[[{]/);
  if (bodyStart >= 0) message = message.slice(0, bodyStart);
  message = message.replace(/\s+/g, " ").trim();
  const head = status !== null ? `${name} (HTTP ${status})` : name;
  const out = message.length > 0 ? `${head}: ${message}` : head;
  return out.slice(0, TYPING_WARNING_MESSAGE_MAX);
}

/**
 * Classify a caught typing-generator failure. Anything that reached a
 * provider (an AI SDK API call error, or a network-layer failure in the
 * cause chain) is a provider failure: typing_generator_error. A failure that
 * means the request could never be built from local configuration (bad URL,
 * invalid options, schema rejection) is typing_configuration_error.
 */
export function classifyTypingFailure(error: unknown): TypingWarningCode {
  const name = (error as { name?: unknown } | null)?.name;
  // AI_RetryError only ever wraps retryable provider call failures.
  if (name === "AI_APICallError" || name === "AI_RetryError") return "typing_generator_error";
  const chain: string[] = [];
  if (error instanceof Error) {
    for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause ?? null) {
      chain.push(`${e.name} ${e.message}`);
    }
  } else {
    chain.push(String(error));
  }
  const text = chain.join(" ");
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|certificate|SSL|TLS|socket/i.test(text)) {
    return "typing_generator_error";
  }
  return "typing_configuration_error";
}

// ── Seed cookies ─────────────────────────────────────────────────────────────

/** A cookie to seed the browser context with before the first navigation. */
export interface SeedCookie {
  name: string;
  value: string;
  /**
   * Omit (recommended): the cookie is host-only, bound to the start URL's
   * exact host and no subdomain, which is what a session cookie captured in
   * a browser usually is. Supply ".example.com" (leading dot) only when the
   * site genuinely sets a subdomain-matching domain cookie.
   */
  domain?: string;
  /** Defaults to "/" so the cookie is sent site-wide. */
  path?: string;
  /**
   * Defaults to true for https start URLs, false for http (loopback
   * fixtures stay seedable). Forced true for __Host-/__Secure- names and
   * for sameSite "None"; an explicit false cannot strip a forced flag.
   */
  secure?: boolean;
  /**
   * Defaults to true: page scripts cannot read the seeded value. Set false
   * only when the site's own JavaScript must read this cookie.
   */
  httpOnly?: boolean;
  /** Defaults to "Lax", the browser default for session cookies. */
  sameSite?: "Strict" | "Lax" | "None";
}

/**
 * Resolves seed cookies into Playwright's `addCookies` shape.
 *
 * What a caller gets when a field is omitted:
 * - domain: omitted from the output decision and sent as the start URL's
 *   hostname without a leading dot, which Chromium stores host-only (the
 *   cookie matches the exact host, never subdomains). A supplied domain is
 *   passed through verbatim; only a leading dot opts into subdomain matching.
 * - path: "/".
 * - secure: true when the start URL is https, false otherwise; forced true
 *   for __Host- and __Secure- names regardless of scheme, and for
 *   sameSite "None"; an explicit secure: false cannot strip a forced flag.
 * - httpOnly: true. Page scripts cannot read the value; the server still
 *   receives it on every request.
 * - sameSite: "Lax".
 *
 * __Host- names must be host-only with path "/" and secure: an explicit
 * domain or a non-root path on such a name is rejected, because the browser
 * would drop the cookie anyway.
 */
export function resolveCookies(
  cookies: SeedCookie[] | undefined,
  startUrl: string,
): Array<{ name: string; value: string; domain: string; path: string; secure: boolean; httpOnly: boolean; sameSite: "Strict" | "Lax" | "None" }> {
  if (!cookies?.length) return [];
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    throw new Error(`seed cookies need a valid start URL, got: ${JSON.stringify(startUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`seed cookies need an http(s) start URL, got: ${JSON.stringify(startUrl)}`);
  }
  return cookies.map((c) => {
    // The error describes the problem without quoting the cookie: the value
    // is a secret, and this throws before the run's redactor exists.
    if (!c.name || typeof c.value !== "string" || c.value === "") {
      const nameState = c.name ? "ok" : "missing";
      const valueState = typeof c.value === "string" ? (c.value === "" ? "empty" : "ok") : `not a string (${typeof c.value})`;
      throw new Error(`cookie needs a name and a value (name: ${nameState}, value: ${valueState})`);
    }
    const prefixed = c.name.startsWith("__Host-") || c.name.startsWith("__Secure-");
    if (c.name.startsWith("__Host-")) {
      if (c.domain !== undefined) throw new Error(`__Host- cookie "${c.name}" must stay host-only; omit domain (it binds to the start URL's exact host)`);
      if (c.path !== undefined && c.path !== "/") throw new Error(`__Host- cookie "${c.name}" requires path "/", got: ${JSON.stringify(c.path)}`);
    }
    return {
      name: c.name,
      value: c.value,
      // Dotless domain through Playwright's addCookies: Chromium stores this
      // host-only (an exact-host match, no subdomains), which is the safe
      // default; a leading dot from the caller opts into subdomain matching.
      domain: c.domain ?? url.hostname,
      path: c.path ?? "/",
      // Forced security dominates the caller: __Host- and __Secure- names
      // and SameSite=None cookies are invalid without the Secure attribute,
      // so an explicit secure: false cannot strip it.
      secure: prefixed || c.sameSite === "None" ? true : (c.secure ?? url.protocol === "https:"),
      httpOnly: c.httpOnly ?? true,
      sameSite: c.sameSite ?? "Lax",
    };
  });
}

/** Parses a CLI `name=value` cookie spec. The value may itself contain `=`. */
export function parseCookieSpec(spec: string): SeedCookie {
  const eq = spec.indexOf("=");
  // The argument is never quoted back: the part after "=" may be a value a
  // user pasted by mistake, and an error echoing it would leak the secret to
  // stderr exactly where the flag was designed to keep it out of.
  if (eq <= 0) throw new Error("cookie expects name=value");
  return { name: spec.slice(0, eq), value: spec.slice(eq + 1) };
}

