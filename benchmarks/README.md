# jev-browser benchmark: speed, reliability, efficiency, correctness

This directory benchmarks the `navigate()` loop of this checkout in headed and headless Chromium. All files are under `benchmarks/`. Production code is not changed. Results and findings are in `REPORT.md`.

`benchmark/` (singular) is earlier, separate work that this suite does not use or change.

## Files

| File | Purpose |
|---|---|
| `cases.mjs` | 12 local cases and 3 public smoke cases: start URL, task, initial state, difficulty, step/time limits, and grader. |
| `fixtures.mjs` | Synthetic local store ("Northwind Coffee Supply"). The harness starts one loopback server per attempt, so every attempt starts from the same state. |
| `oracle.mjs` | Scripted reference solutions. Used only by `--transport oracle` to prove that each case can be solved and graded. |
| `run.mjs` | Runner: schedule, browser launch, metering, budget cap, grading, raw evidence. |
| `report.mjs` | Aggregates `runs.jsonl` into `runs.csv`, `summary.json` and `summary.md`. |
| `test.mjs` | Checks for the statistics helpers. |
| `results/<run>/` | One directory per campaign: `meta.json`, `runs.jsonl`, `runs.csv`, `ledger.jsonl`, `stop.json`, `summary.*`, `traces/` (full result JSON and final screenshot per attempt). `traces/` is not committed (see `.gitignore`). A new run writes it again. |

## Commands

Run from the repository root. Each `--out` directory must not exist; the runner refuses to overwrite.

Offline (no paid calls):

```sh
npm run build                      # dist/ must match src/
node --test benchmarks/test.mjs
# fixtures and graders, both modes, plus a negative control per attempt
node benchmarks/run.mjs --transport oracle --reps 1 --warmup 0 --out benchmarks/results/<new>
# real navigate() loop, mock judgments (harness validation only)
node benchmarks/run.mjs --transport mock-done   --reps 1 --out benchmarks/results/<new>
node benchmarks/run.mjs --transport mock-random --reps 1 --out benchmarks/results/<new>
```

Paid (only after a person approves the spend and runtime caps). The TypeSafe key is read from `TYPESAFE_API_KEY` or `~/.config/typesafe/key`. `zsh -ic` is needed only for `--typing openrouter`, because `OPENROUTER_API_KEY` is set in the interactive shell:

```sh
# paired campaign, both modes, randomized pair order
zsh -ic 'node benchmarks/run.mjs --transport typesafe --paid-approved --budget-usd <cap> --max-minutes <cap> \
  --typing openrouter --typing-price-in 0.18 --typing-price-out 0.72 --out benchmarks/results/<new>'
# one mode only
node benchmarks/run.mjs --transport typesafe --paid-approved --budget-usd <cap> --modes headless --out benchmarks/results/<new>
node benchmarks/run.mjs --transport typesafe --paid-approved --budget-usd <cap> --modes headed   --out benchmarks/results/<new>
# public read-only smoke suite (live evidence)
node benchmarks/run.mjs --suite public --transport typesafe --paid-approved --budget-usd <cap> --reps 3 --out benchmarks/results/<new>
# re-aggregate an existing results directory
node benchmarks/report.mjs benchmarks/results/<run>
```

Other options: `--cases id1,id2`, `--reps N` (default 5), `--warmup N` (excluded warm-ups per mode, default 1), `--seed N` (default 20261018), `--model` (default `jev-1.13.0`).

## Methodology

**What is exercised.** Every non-oracle attempt calls the public `navigate()` from `dist/library.js` with the harness's own Playwright page. Injecting the page is a documented library interface (README, "Reuse an existing Playwright page"). Mock transports (`mock-done`, `mock-random`) run the real loop with fake judgments. They validate the harness only and are never reported as Jev results.

**Why the page is injected.** On its own browser, `navigate()` launches `chromium.launch({ headless: JEV_BROWSER_HEADED !== "1" })` (`src/navigate.ts:709`). In Playwright 1.64, headless without a channel runs the separate *chromium headless shell*, and headed runs full Chromium. The production switch therefore changes the binary as well as the mode. The harness launches `channel: "chromium"` in both modes, so both use the same Chrome for Testing build (`meta.json` → `environment.browsers` records version and user agent for both, plus the production default headless shell for comparison). The harness copies the owned-context settings from `navigate()`: viewport 1024×640 and an 8 s default timeout. It also fixes locale `en-US`, timezone UTC and device scale factor 1.

**Isolation and reset.** Each attempt gets a new browser process, a new context with no profile or cookies, and a new fixture server whose state is created from scratch. Local attempts abort every browser request not addressed to the fixture origin. Public attempts abort every non-GET browser request (read-only). The fixture has no browser-reachable state or grading endpoint.

**Oracle separation.** `navigate()` receives only `task`, `startUrl`, `page`, `transport` and limits. Selectors and expected values exist only in `grade()` and `oracle.mjs`, which run in the harness process after the attempt.

**Grading.** A pass needs independent evidence: final URL, DOM values, rendered rows, fixture writes, or the returned payload. The reported `status` is never enough. Two cases use status as an extra requirement: `stop-before-submit` must stop (`done`/`goal_achieved`), and `unavailable-target` must not claim success. Every case also requires zero unexpected fixture writes. In oracle mode a negative control grades each untouched initial state as if success had been claimed. It must fail.

**Schedule.** One excluded warm-up per mode, then for each repetition the cases are shuffled with a seeded PRNG (mulberry32, `--seed`) and each case runs as a headed/headless pair in random order. Attempts run sequentially (concurrency 1). The full schedule is in `meta.json` before the first attempt.

**Timing.** `startup_ms`: browser launch + context + page. `task_ms`: `navigate()`'s own `elapsed_ms`, which includes the first `goto` and the final payload and screenshot. `wall_ms`: the harness's timer around `navigate()`. `jev_ms`: summed time inside Jev transport calls. Grading is outside all of these.

**Counting.** `decision_steps` = step records (one primary Jev call each). `executed_actions` = steps with an executed action. A search is one action but two browser operations (fill + Enter), so `search_actions` is reported separately. `recoveries` = steps where the repeat-no-op recovery switched actions. `jev_calls` = logical transport calls (includes the second call for dropdowns). `jev_http_requests` = HTTP attempts to `api.typesafe.ai` (the transport retries 408/409/429/5xx up to 3 times). `jev_retries` = the difference.

**Usage and cost.** A `fetch` wrapper in the harness process sees every outbound Node request. It blocks any host other than `api.typesafe.ai` and, when typing is enabled, `openrouter.ai`. Before each request it reserves a worst-case cost: 65,536 tokens for Jev, 2,000 in + 256 out for typing. It refuses the request if the reservation would cross `--budget-usd`, then settles the reservation to the measured tokens. Tokens are measured from response bodies. Cost is an **estimate** from measured tokens × price (Jev: $0.042 per million input tokens, output free, docs.typesafe.ai/models on 2026-10-18; typing: the price passed on the command line). When a response has no usage, its cost is `null` (unknown) and the reservation stays counted against the cap. `library_reported_usage` keeps `navigate()`'s own usage object; it counts Jev input tokens only and never counts typing. Every request is in `ledger.jsonl`, warm-ups included.

**Environment control.** The runner deletes every typing and transport credential from its own process, then re-adds only what the campaign names. Without that step, the auto-detection in `resolveTypingSelection` would pick any `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY` or Gemini key that happens to be set.

**Stop rules.** Budget cap, `--max-minutes`, or 3 consecutive infrastructure failures. Unexecuted slots are listed in `stop.json`. No attempt is retried or replaced.

**Failure categories.** `pass`, `pass_without_stop` (correct end state but no stop claimed), `false_success` (claimed done/goal_achieved, not verified), `unsafe_write` (submitted, saved or ordered against the task), `typing_unavailable`, `agent_stuck`, `agent_max_steps`, `agent_blocked`, `timeout`, `infrastructure`, `budget_cap`.

**Statistics.** Completion rate with a Wilson 95% interval. False-success rate as a share of attempts and of claims. Median (midpoint for even n) and nearest-rank p95. Paired mode comparison: concordance table, exact two-sided McNemar test on discordant pairs, median paired task-time difference. Repeated attempts on one deterministic fixture are correlated, so intervals describe this suite, not websites in general. Cells under 30 attempts are flagged as small samples.
