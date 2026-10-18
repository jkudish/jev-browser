#!/usr/bin/env node
// Benchmark runner. See benchmarks/README.md for commands and methodology.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { navigate } from "../dist/library.js";
import { resolveTransport } from "../dist/provider.js";
import { LOCAL_CASES, PUBLIC_CASES } from "./cases.mjs";
import { startFixture } from "./fixtures.mjs";
import { ORACLE, ORACLE_STATUS } from "./oracle.mjs";
import { writeReport } from "./report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const { values: args } = parseArgs({
  options: {
    suite: { type: "string", default: "local" }, // local | public
    modes: { type: "string", default: "headed,headless" },
    transport: { type: "string", default: "oracle" }, // oracle | mock-done | mock-random | typesafe
    reps: { type: "string", default: "5" },
    warmup: { type: "string", default: "1" }, // excluded warm-up attempts per mode
    cases: { type: "string" },
    seed: { type: "string", default: "20261018" },
    model: { type: "string", default: "jev-1.13.0" },
    typing: { type: "string", default: "none" }, // none | openrouter
    "typing-model": { type: "string", default: "google/gemini-2.5-flash-lite" },
    "typing-price-in": { type: "string" }, // USD per million input tokens
    "typing-price-out": { type: "string" }, // USD per million output tokens
    "budget-usd": { type: "string" },
    "max-minutes": { type: "string", default: "180" },
    "paid-approved": { type: "boolean", default: false },
    out: { type: "string" },
  },
});

const JEV_PRICE_PER_MTOK_IN = 0.042; // docs.typesafe.ai/models, retrieved 2026-10-18; output tokens free
const JEV_WORST_CASE_TOKENS = 65_536; // default per-request context limit
const TYPING_WORST_CASE = { in: 2_000, out: 256 };
const TYPING_HOSTS = new Set(["openrouter.ai"]);
const VIEWPORT = { width: 1024, height: 640 }; // same as navigate()'s owned context
const DEFAULT_TIMEOUT_MS = 8_000; // same as navigate()'s owned context

const fail = (msg) => { console.error(msg); process.exit(2); };
if (!args.out) fail("--out <dir> is required");
const OUT = resolve(args.out);
if (existsSync(OUT)) fail(`refusing to overwrite ${OUT}; choose a new --out directory`);
const suite = args.suite;
if (!["local", "public"].includes(suite)) fail("--suite must be local or public");
const modes = args.modes.split(",").map((m) => m.trim());
if (!modes.every((m) => m === "headed" || m === "headless")) fail("--modes accepts headed,headless");
const paid = args.transport === "typesafe" || args.typing !== "none";
if (paid && !args["paid-approved"]) fail("paid inference needs --paid-approved and --budget-usd after explicit human approval");
if (paid && !(Number(args["budget-usd"]) > 0)) fail("--budget-usd must be a positive number for paid runs");
if (args.typing !== "none" && args.typing !== "openrouter") fail("--typing accepts none or openrouter");
if (args.typing === "openrouter" && !(args["typing-price-in"] && args["typing-price-out"])) fail("--typing-price-in and --typing-price-out are required with --typing");
if (suite === "public" && args.transport === "oracle") fail("the public suite has no oracle; use mock-done or typesafe");
const BUDGET = paid ? Number(args["budget-usd"]) : 0;
const DEADLINE = Date.now() + Number(args["max-minutes"]) * 60_000;
const TYPING_PRICE = { in: Number(args["typing-price-in"] ?? 0), out: Number(args["typing-price-out"] ?? 0) };

// ── Environment control: only the providers this campaign names can be used ──
const typesafeKey = process.env.TYPESAFE_API_KEY || (existsSync(join(os.homedir(), ".config/typesafe/key")) ? readFileSync(join(os.homedir(), ".config/typesafe/key"), "utf8").trim() : "");
const openrouterKey = process.env.OPENROUTER_API_KEY;
for (const k of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "JEV_BROWSER_TYPE_PROVIDER", "JEV_BROWSER_TYPE_MODEL", "JEV_BROWSER_TYPE_BASE_URL", "JEV_BROWSER_TYPE_API_KEY", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "JEV_PROVIDER", "JEV_BROWSER_HEADED", "AI_GATEWAY_API_KEY", "CLOUDFLARE_API_TOKEN", "JEV_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete process.env[k];
process.env.JEV_BROWSER_MODEL = args.model;
if (args.typing === "openrouter") {
  if (!openrouterKey) fail("--typing openrouter needs OPENROUTER_API_KEY in the environment");
  process.env.OPENROUTER_API_KEY = openrouterKey;
  process.env.JEV_BROWSER_TYPE_PROVIDER = "openrouter";
  process.env.JEV_BROWSER_TYPE_MODEL = args["typing-model"];
}
if (args.transport === "typesafe" && !typesafeKey) fail("no TypeSafe key in TYPESAFE_API_KEY or ~/.config/typesafe/key");

// ── Outbound meter: every non-loopback Node fetch is classified, capped, and ledgered ──
const meter = {
  spent: 0, // measured-token estimate, or the reservation when usage is unknown
  capHit: false,
  attempt: null,
  ledger: null,
  begin() { this.attempt = { jev: [], typing: [] }; },
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);
  const kind = url.hostname === "api.typesafe.ai" ? "jev" : TYPING_HOSTS.has(url.hostname) ? "typing" : null;
  if (!kind) throw new Error(`benchmark meter: blocked unexpected outbound request to ${url.hostname}`);
  const reserve = kind === "jev"
    ? JEV_WORST_CASE_TOKENS * JEV_PRICE_PER_MTOK_IN / 1e6
    : (TYPING_WORST_CASE.in * TYPING_PRICE.in + TYPING_WORST_CASE.out * TYPING_PRICE.out) / 1e6;
  if (meter.spent + reserve > BUDGET) {
    meter.capHit = true;
    throw new Error("benchmark budget cap reached; request not sent");
  }
  meter.spent += reserve;
  const entry = { t: new Date().toISOString(), kind, host: url.hostname, reserved_usd: reserve };
  const t0 = performance.now();
  let res;
  try {
    res = await realFetch(input, init);
  } catch (error) {
    Object.assign(entry, { ms: Math.round(performance.now() - t0), error: String(error?.name ?? "fetch error"), settled_usd: null });
    appendFileSync(meter.ledger, JSON.stringify(entry) + "\n");
    meter.attempt?.[kind].push(entry);
    throw error;
  }
  entry.ms = Math.round(performance.now() - t0);
  entry.status = res.status;
  const body = await res.clone().json().catch(() => null);
  const u = body?.usage;
  if (kind === "jev" && u && Number.isFinite(u.input_tokens)) {
    entry.input_tokens = u.input_tokens;
    entry.output_tokens = u.output_tokens ?? 0;
    entry.model = body.model ?? null;
    entry.settled_usd = u.input_tokens * JEV_PRICE_PER_MTOK_IN / 1e6;
  } else if (kind === "typing" && u && Number.isFinite(u.prompt_tokens)) {
    entry.input_tokens = u.prompt_tokens;
    entry.output_tokens = u.completion_tokens ?? 0;
    entry.model = body.model ?? null;
    entry.provider_reported_cost_usd = Number.isFinite(u.cost) ? u.cost : null;
    entry.settled_usd = (entry.input_tokens * TYPING_PRICE.in + entry.output_tokens * TYPING_PRICE.out) / 1e6;
  } else {
    entry.settled_usd = null; // billing unknown: the reservation stays counted
  }
  if (entry.settled_usd !== null) meter.spent += entry.settled_usd - reserve;
  appendFileSync(meter.ledger, JSON.stringify(entry) + "\n");
  meter.attempt?.[kind].push(entry);
  return res;
};

// ── Transports ──
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function mockAnswers(questions, pick) {
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") { answers[id] = { type: "noul", noul: 0.05 }; continue; }
    const keys = Object.keys(q.criteria);
    const chosen = pick(keys);
    const rest = keys.length > 1 ? 0.5 / (keys.length - 1) : 0;
    const probabilities = Object.fromEntries(keys.map((k) => [k, k === chosen ? (keys.length > 1 ? 0.5 : 1) : rest]));
    answers[id] = { type: "choice", choice: chosen, probabilities, confidence: 0.5 };
  }
  return answers;
}
function makeTransport(kind, seed) {
  if (kind === "typesafe") return resolveTransport({ JEV_PROVIDER: "typesafe", TYPESAFE_API_KEY: typesafeKey });
  if (kind === "mock-done") return { name: "mock-done", async ask({ questions }) { return { answers: mockAnswers(questions, (k) => (k.includes("done") ? "done" : k[0])), usage: { input_tokens: 0, output_tokens: 0 }, model: "mock" }; } };
  if (kind === "mock-random") {
    const r = rng(seed);
    return { name: "mock-random", async ask({ questions }) { return { answers: mockAnswers(questions, (k) => { const pool = k.filter((x) => x !== "done"); return pool[Math.floor(r() * pool.length)] ?? k[0]; }), usage: { input_tokens: 0, output_tokens: 0 }, model: "mock" }; } };
  }
  throw new Error(`unknown transport ${kind}`);
}
// Per-attempt logical call log, wrapping (not altering) the transport.
function instrumented(transport, log) {
  return {
    name: transport.name,
    async ask(input) {
      const t0 = performance.now();
      try {
        const reply = await transport.ask(input);
        log.push({ ok: true, ms: Math.round(performance.now() - t0), model: reply.model, input_tokens: reply.usage?.input_tokens ?? null, questions: Object.keys(input.questions) });
        return reply;
      } catch (error) {
        log.push({ ok: false, ms: Math.round(performance.now() - t0), error: String(error?.message ?? error).slice(0, 160), questions: Object.keys(input.questions) });
        throw error;
      }
    },
  };
}

// ── Metadata recorded before any attempt ──
const sh = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: "utf8", cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
async function probeBrowsers() {
  const out = {};
  for (const [label, opts] of [["harness_headed", { channel: "chromium", headless: false }], ["harness_headless", { channel: "chromium", headless: true }], ["production_default_headless", { headless: true }]]) {
    if (label === "harness_headed" && !modes.includes("headed")) continue;
    try {
      const b = await chromium.launch(opts);
      const p = await b.newPage();
      out[label] = { version: b.version(), user_agent: await p.evaluate(() => navigator.userAgent) };
      await b.close();
    } catch (error) {
      out[label] = { error: String(error.message).split("\n")[0] };
    }
  }
  out.executable_path_chromium = chromium.executablePath();
  return out;
}
function display() {
  const raw = sh("system_profiler", ["SPDisplaysDataType", "-json"]);
  try {
    return JSON.parse(raw).SPDisplaysDataType.flatMap((g) => (g.spdisplays_ndrvs ?? []).map((d) => ({ name: d._name, resolution: d._spdisplays_resolution ?? d.spdisplays_resolution, main: d.spdisplays_main === "spdisplays_yes" })));
  } catch { return null; }
}

// ── Schedule ──
const caseList = (suite === "local" ? LOCAL_CASES : PUBLIC_CASES).filter((c) => !args.cases || args.cases.split(",").includes(c.id));
if (!caseList.length) fail("no cases selected");
const seed = Number(args.seed);
const order = rng(seed);
const shuffle = (xs) => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(order() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const schedule = [];
for (let w = 0; w < Number(args.warmup); w++) for (const mode of shuffle(modes)) schedule.push({ case: caseList[0], mode, rep: 0, warmup: true, pair: null });
let pairN = 0;
for (let rep = 1; rep <= Number(args.reps); rep++) {
  for (const c of shuffle(caseList)) {
    const pair = `p${++pairN}`;
    for (const mode of shuffle(modes)) schedule.push({ case: c, mode, rep, warmup: false, pair });
  }
}
schedule.forEach((s, i) => { s.index = i; s.seed = seed + i; });

// ── One attempt ──
async function runAttempt(s, browserInfo) {
  const c = s.case;
  const fixture = suite === "local" ? await startFixture(c.id) : null;
  const startUrl = fixture ? fixture.base + c.start : c.start;
  const blocked = [];
  const rec = {
    run_id: `${String(s.index).padStart(3, "0")}-${c.id}-${s.mode}`,
    suite, evidence_type: suite === "local" ? "synthetic-local" : "live-public", transport: args.transport,
    measured: !s.warmup && args.transport === "typesafe", warmup: s.warmup,
    case: c.id, category: c.category, difficulty: c.difficulty, mode: s.mode, rep: s.rep, seed: s.seed, pair_id: s.pair, order_index: s.index,
    started_at: new Date().toISOString(),
  };
  let browser;
  const calls = [];
  meter.begin();
  try {
    const t0 = performance.now();
    browser = await chromium.launch({ channel: "chromium", headless: s.mode === "headless" });
    const context = await browser.newContext({ viewport: VIEWPORT, locale: "en-US", timezoneId: "UTC", deviceScaleFactor: 1 });
    context.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    await context.route("**/*", (route) => {
      const r = route.request();
      const u = new URL(r.url());
      const ok = fixture ? u.origin === fixture.base : r.method() === "GET" || r.method() === "HEAD";
      if (ok || u.protocol === "data:") return route.continue();
      blocked.push(`${r.method()} ${u.origin}${u.pathname}`.slice(0, 160));
      return route.abort();
    });
    const page = await context.newPage();
    rec.startup_ms = Math.round(performance.now() - t0);
    rec.browser_version = browser.version();

    let result;
    const tw = performance.now();
    if (args.transport === "oracle") {
      await page.goto(startUrl, { waitUntil: "domcontentloaded" });
      // Negative control: claiming success on the untouched initial state must fail.
      const neg = await c.grade({ result: { status: "done", final_url: page.url(), page: { content: await page.evaluate(() => document.body.innerText) } }, state: fixture?.state, pages: context.pages(), final: page, base: fixture?.base });
      rec.negative_control_pass = neg.pass;
      const end = await ORACLE[c.id](page);
      result = { status: ORACLE_STATUS[c.id] ?? "done", final_url: end.url(), page: { content: await end.evaluate(() => document.body.innerText) }, steps: [], usage: {}, elapsed_ms: Math.round(performance.now() - tw), degraded: false, warnings: [] };
    } else {
      const transport = instrumented(makeTransport(args.transport, s.seed), calls);
      const guardMs = (c.limits.maxSeconds + 30) * 1000;
      result = await Promise.race([
        navigate({ task: c.task, startUrl, page, transport, maxSteps: c.limits.maxSteps, maxSeconds: c.limits.maxSeconds, format: "text", screenshot: "final" }),
        new Promise((resolveGuard) => setTimeout(() => resolveGuard({ status: "error", error: "harness guard timeout", steps: [] }), guardMs).unref()),
      ]);
    }
    rec.wall_ms = Math.round(performance.now() - tw);
    rec.task_ms = result.elapsed_ms ?? null;
    rec.navigate_status = result.status;
    rec.navigate_error = result.error ?? null;
    writeFileSync(join(OUT, "traces", `${rec.run_id}.json`), JSON.stringify({ partial: true, result: { ...result, screenshot_base64_jpeg: null }, jev_calls: calls }, null, 1));

    const pages = context.pages();
    const final = pages.find((p) => p.url() === result.final_url) ?? pages.at(-1);
    if (!final) throw new Error(`no open page after navigate (status ${result.status}; error ${result.error ?? "none"}; browser connected ${browser.isConnected()})`);
    const focus = await final.evaluate(() => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState })).catch(() => ({}));
    const tg = performance.now();
    const g = await c.grade({ result, state: fixture?.state, pages, final, base: fixture?.base });
    rec.grade_ms = Math.round(performance.now() - tg);

    const steps = result.steps ?? [];
    const jevHttp = meter.attempt.jev;
    const typing = meter.attempt.typing;
    const sum = (xs, k) => (xs.every((x) => Number.isFinite(x[k])) ? xs.reduce((a, x) => a + x[k], 0) : null);
    Object.assign(rec, {
      reported_status: result.status,
      claimed_success: result.status === "done" || result.status === "goal_achieved",
      verified_pass: g.pass,
      failure_reason: g.reason || null,
      error: result.error ?? null,
      final_url: result.final_url ?? final.url(),
      executed_actions: steps.filter((x) => x.executed_action).length,
      search_actions: steps.filter((x) => x.executed_action?.startsWith("search_")).length,
      decision_steps: steps.length,
      recoveries: steps.filter((x) => x.recovery_reason).length,
      action_errors: steps.filter((x) => x.action_error).length,
      jev_calls: calls.length,
      jev_failed_calls: calls.filter((x) => !x.ok).length,
      jev_http_requests: jevHttp.length,
      jev_retries: args.transport === "typesafe" ? Math.max(0, jevHttp.length - calls.length) : 0,
      jev_input_tokens: args.transport === "typesafe" ? sum(jevHttp, "input_tokens") : null,
      jev_output_tokens: args.transport === "typesafe" ? sum(jevHttp, "output_tokens") : null,
      jev_model: [...new Set(calls.map((x) => x.model).filter(Boolean))].join("|") || null,
      jev_ms: calls.reduce((a, x) => a + x.ms, 0),
      jev_cost_usd_est: args.transport === "typesafe" ? (jevHttp.every((x) => x.settled_usd !== null) ? jevHttp.reduce((a, x) => a + x.settled_usd, 0) : null) : 0,
      typing_provider: result.typing_provider ?? null,
      typing_model: result.typing_model ?? null,
      typing_http_requests: typing.length,
      typing_input_tokens: sum(typing, "input_tokens"),
      typing_output_tokens: sum(typing, "output_tokens"),
      typing_cost_usd_est: typing.every((x) => x.settled_usd !== null) ? typing.reduce((a, x) => a + x.settled_usd, 0) : null,
      degraded: !!result.degraded,
      warning_codes: (result.warnings ?? []).map((w) => w.code).join("|") || null,
      library_reported_usage: result.usage ?? null,
      fixture_writes: fixture ? fixture.state.writes.length : null,
      fixture_write_paths: fixture ? fixture.state.writes.map((w) => w.path).join("|") || null : null,
      blocked_requests: blocked.length,
      has_focus: focus.hasFocus ?? null,
      visibility: focus.visibility ?? null,
      negative_control_pass: rec.negative_control_pass ?? null,
      evidence: g.evidence,
    });
    rec.failure_category = categorize(rec, c);
    // Raw trace for audit: full result minus the screenshot, plus call logs.
    const shot = result.screenshot_base64_jpeg;
    if (shot) writeFileSync(join(OUT, "traces", `${rec.run_id}.jpg`), Buffer.from(shot, "base64"));
    writeFileSync(join(OUT, "traces", `${rec.run_id}.json`), JSON.stringify({ record: rec, task: c.task, start_url: startUrl, result: { ...result, screenshot_base64_jpeg: shot ? `${rec.run_id}.jpg` : null }, jev_calls: calls, outbound: meter.attempt, blocked_requests: blocked, fixture_state: fixture?.state ?? null, browser: browserInfo }, null, 1));
  } catch (error) {
    Object.assign(rec, { reported_status: "harness_error", claimed_success: false, verified_pass: false, error: String(error?.message ?? error).slice(0, 300), failure_category: "infrastructure" });
  } finally {
    await browser?.close().catch(() => {});
    await fixture?.close();
  }
  return rec;
}

function categorize(r, c) {
  if (r.verified_pass) return r.claimed_success || c.id === "unavailable-target" ? "pass" : "pass_without_stop";
  if (r.error && /budget cap/.test(r.error)) return "budget_cap";
  if (r.reported_status === "error") return /deadline|guard/.test(r.error ?? "") ? "timeout" : "infrastructure";
  if (r.reported_status === "timeout") return "timeout";
  // Any fixture write on a failed attempt is a write the task did not ask for
  // (or saved the wrong state, for ambiguous-save).
  if (r.fixture_writes > 0) return "unsafe_write";
  if (r.claimed_success) return "false_success";
  if (c.needs_typing && /typing_fallback_no_provider|typing_generator/.test(r.warning_codes ?? "")) return "typing_unavailable";
  return `agent_${r.reported_status}`; // agent_stuck, agent_max_steps, agent_blocked
}

// ── Main ──
mkdirSync(join(OUT, "traces"), { recursive: true });
meter.ledger = join(OUT, "ledger.jsonl");
writeFileSync(meter.ledger, "");
const browsers = await probeBrowsers();
const meta = {
  created_at: new Date().toISOString(),
  command: process.argv.slice(2).join(" "),
  evidence_type: suite === "local" ? "synthetic-local" : "live-public",
  repo: { commit: sh("git", ["rev-parse", "HEAD"]), status_short: sh("git", ["status", "--short"]), package_version: JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version },
  hashes: Object.fromEntries(["dist/navigate.js", "dist/lib.js", "dist/questions.js", "dist/provider.js", "benchmarks/run.mjs", "benchmarks/cases.mjs", "benchmarks/fixtures.mjs", "benchmarks/oracle.mjs", "benchmarks/report.mjs"].map((p) => [p, sha(join(REPO, p))])),
  environment: {
    os: `${sh("sw_vers", ["-productName"])} ${sh("sw_vers", ["-productVersion"])} (${os.release()})`, arch: os.arch(), cpu: os.cpus()[0]?.model, cpus: os.cpus().length, memory_gb: Math.round(os.totalmem() / 2 ** 30),
    node: process.version, playwright: JSON.parse(readFileSync(join(REPO, "node_modules/playwright/package.json"), "utf8")).version,
    displays: display(), browsers,
    network: suite === "local" ? "loopback fixture only; all other browser origins aborted" : "unthrottled host network, unmeasured; non-GET browser requests aborted",
  },
  configuration: {
    suite, modes, transport: args.transport, jev_model_requested: args.model, typing: args.typing === "none" ? null : { provider: "openrouter", model: args["typing-model"], price_per_mtok: TYPING_PRICE, price_source: "operator-supplied at approval" },
    browser_launch: { channel: "chromium", headless_by_mode: { headed: false, headless: true } }, context: { viewport: VIEWPORT, locale: "en-US", timezoneId: "UTC", deviceScaleFactor: 1, default_timeout_ms: DEFAULT_TIMEOUT_MS },
    format: "text", reps: Number(args.reps), warmup_per_mode: Number(args.warmup), seed, concurrency: 1,
    jev_price_per_mtok_in: JEV_PRICE_PER_MTOK_IN, jev_worst_case_reservation_tokens: JEV_WORST_CASE_TOKENS,
    budget_usd: BUDGET, max_minutes: Number(args["max-minutes"]), infra_stop_after_consecutive: 3,
  },
  cases: caseList.map(({ grade, ...c }) => c),
  schedule: schedule.map((s) => ({ index: s.index, case: s.case.id, mode: s.mode, rep: s.rep, warmup: s.warmup, pair: s.pair, seed: s.seed })),
};
writeFileSync(join(OUT, "meta.json"), JSON.stringify(meta, null, 1));
console.error(`benchmark: ${schedule.length} attempts scheduled (${suite}, ${args.transport}); writing ${OUT}`);

const runsPath = join(OUT, "runs.jsonl");
writeFileSync(runsPath, "");
let consecutiveInfra = 0;
let stopReason = null;
for (const s of schedule) {
  if (Date.now() > DEADLINE) { stopReason = "runtime cap reached"; break; }
  if (meter.capHit) { stopReason = "budget cap reached"; break; }
  if (consecutiveInfra >= 3) { stopReason = "three consecutive infrastructure failures"; break; }
  const rec = await runAttempt(s, browsers);
  appendFileSync(runsPath, JSON.stringify(rec) + "\n");
  consecutiveInfra = rec.failure_category === "infrastructure" ? consecutiveInfra + 1 : 0;
  console.error(`${rec.run_id} status=${rec.reported_status} verified=${rec.verified_pass} category=${rec.failure_category} task_ms=${rec.task_ms} steps=${rec.decision_steps ?? "-"} spent=$${meter.spent.toFixed(4)}`);
}
const done = new Set(readFileSync(runsPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).order_index));
const unexecuted = schedule.filter((s) => !done.has(s.index)).map((s) => ({ index: s.index, case: s.case.id, mode: s.mode, rep: s.rep, warmup: s.warmup }));
writeFileSync(join(OUT, "stop.json"), JSON.stringify({ stop_reason: stopReason ?? "schedule complete", spent_usd_estimate: meter.spent, unexecuted }, null, 1));
writeReport(OUT);
console.error(`benchmark: ${stopReason ?? "schedule complete"}; ${unexecuted.length} unexecuted; spent≈$${meter.spent.toFixed(4)}`);
