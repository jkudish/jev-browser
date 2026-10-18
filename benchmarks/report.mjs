// Aggregates runs.jsonl into runs.csv, summary.json and summary.md.
// Usage: node benchmarks/report.mjs <results-dir>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
export function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
export function p95(xs) { // nearest rank
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  return a.length ? a[Math.ceil(0.95 * a.length) - 1] : null;
}
/** Exact two-sided McNemar test on b, c discordant pairs. */
export function mcnemar(b, c) {
  const n = b + c;
  if (!n) return null;
  const choose = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
  let tail = 0;
  for (let i = 0; i <= Math.min(b, c); i++) tail += choose(n, i);
  return Math.min(1, 2 * tail / 2 ** n);
}
const sumOrNull = (xs) => (xs.every(Number.isFinite) ? xs.reduce((a, x) => a + x, 0) : null);
const pct = (x) => (x === null || x === undefined ? "n/a" : `${(100 * x).toFixed(1)}%`);
const ci = (w) => (w ? `${pct(w[0])}–${pct(w[1])}` : "n/a");

const CSV_FIELDS = ["run_id", "suite", "evidence_type", "transport", "measured", "warmup", "case", "category", "difficulty", "mode", "rep", "seed", "pair_id", "order_index", "reported_status", "claimed_success", "verified_pass", "failure_category", "failure_reason", "startup_ms", "task_ms", "wall_ms", "grade_ms", "executed_actions", "search_actions", "decision_steps", "recoveries", "action_errors", "jev_calls", "jev_failed_calls", "jev_http_requests", "jev_retries", "jev_input_tokens", "jev_output_tokens", "jev_model", "jev_ms", "jev_cost_usd_est", "typing_provider", "typing_model", "typing_http_requests", "typing_input_tokens", "typing_output_tokens", "typing_cost_usd_est", "degraded", "warning_codes", "fixture_writes", "fixture_write_paths", "blocked_requests", "has_focus", "visibility", "negative_control_pass", "browser_version", "final_url", "error", "evidence"];
const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function summarize(rows) {
  const n = rows.length, k = rows.filter((r) => r.verified_pass).length;
  const claimed = rows.filter((r) => r.claimed_success);
  const falseSuccess = rows.filter((r) => r.failure_category === "false_success").length;
  const categories = {};
  for (const r of rows) categories[r.failure_category] = (categories[r.failure_category] ?? 0) + 1;
  const jevCost = sumOrNull(rows.map((r) => r.jev_cost_usd_est));
  const typingCost = sumOrNull(rows.map((r) => r.typing_cost_usd_est ?? 0));
  const total = jevCost === null || typingCost === null ? null : jevCost + typingCost;
  return {
    attempts: n, verified_passes: k, completion_rate: n ? k / n : null, completion_wilson95: wilson(k, n),
    claimed_successes: claimed.length, false_successes: falseSuccess,
    false_success_rate_of_attempts: n ? falseSuccess / n : null,
    false_success_rate_of_claims: claimed.length ? falseSuccess / claimed.length : null,
    failure_categories: categories,
    task_ms_median: median(rows.map((r) => r.task_ms)), task_ms_p95: p95(rows.map((r) => r.task_ms)),
    startup_ms_median: median(rows.map((r) => r.startup_ms)), startup_ms_p95: p95(rows.map((r) => r.startup_ms)),
    pass_task_ms_median: median(rows.filter((r) => r.verified_pass).map((r) => r.task_ms)),
    executed_actions_median: median(rows.map((r) => r.executed_actions)), decision_steps_median: median(rows.map((r) => r.decision_steps)),
    recoveries_total: sumOrNull(rows.map((r) => r.recoveries ?? 0)), action_errors_total: sumOrNull(rows.map((r) => r.action_errors ?? 0)),
    jev_calls_total: sumOrNull(rows.map((r) => r.jev_calls ?? 0)), jev_http_requests_total: sumOrNull(rows.map((r) => r.jev_http_requests ?? 0)), jev_retries_total: sumOrNull(rows.map((r) => r.jev_retries ?? 0)),
    jev_input_tokens_total: sumOrNull(rows.map((r) => r.jev_input_tokens)),
    typing_http_requests_total: sumOrNull(rows.map((r) => r.typing_http_requests ?? 0)),
    jev_cost_usd_est: jevCost, typing_cost_usd_est: typingCost, total_cost_usd_est: total,
    cost_per_verified_success_usd_est: total !== null && k ? total / k : null,
    degraded_runs: rows.filter((r) => r.degraded).length,
    small_sample: n < 30,
  };
}

function paired(rows) {
  const byPair = new Map();
  for (const r of rows) if (r.pair_id) byPair.set(r.pair_id, { ...byPair.get(r.pair_id), [r.mode]: r });
  const pairs = [...byPair.values()].filter((p) => p.headed && p.headless);
  const t = { both_pass: 0, headed_only: 0, headless_only: 0, both_fail: 0 };
  const diffs = [];
  for (const p of pairs) {
    const a = p.headed.verified_pass, b = p.headless.verified_pass;
    t[a && b ? "both_pass" : a ? "headed_only" : b ? "headless_only" : "both_fail"]++;
    if (Number.isFinite(p.headed.task_ms) && Number.isFinite(p.headless.task_ms)) diffs.push(p.headed.task_ms - p.headless.task_ms);
  }
  const statusAgree = pairs.filter((p) => p.headed.reported_status === p.headless.reported_status).length;
  return { pairs: pairs.length, ...t, mcnemar_exact_p: mcnemar(t.headed_only, t.headless_only), reported_status_agreement: pairs.length ? statusAgree / pairs.length : null, task_ms_diff_headed_minus_headless_median: median(diffs), task_ms_diff_p95_abs: p95(diffs.map(Math.abs)), small_sample: pairs.length < 30 };
}

export function writeReport(dir) {
  const rows = readFileSync(join(dir, "runs.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  writeFileSync(join(dir, "runs.csv"), [CSV_FIELDS.join(","), ...rows.map((r) => CSV_FIELDS.map((f) => csvCell(r[f])).join(","))].join("\n") + "\n");
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const stop = existsSync(join(dir, "stop.json")) ? JSON.parse(readFileSync(join(dir, "stop.json"), "utf8")) : null;
  const ledger = existsSync(join(dir, "ledger.jsonl")) ? readFileSync(join(dir, "ledger.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const measured = rows.filter((r) => !r.warmup);
  const modes = [...new Set(measured.map((r) => r.mode))];
  const cases = [...new Set(measured.map((r) => r.case))];
  const summary = {
    label: meta.transport === "typesafe" || meta.configuration?.transport === "typesafe" ? `${meta.evidence_type}, real Jev loop` : `${meta.evidence_type}, harness validation only (${meta.configuration?.transport}); not a measurement of Jev`,
    stop,
    all_phases_ledger: {
      outbound_requests: ledger.length,
      settled_usd_est: ledger.reduce((a, e) => a + (e.settled_usd ?? 0), 0),
      unknown_billing_requests: ledger.filter((e) => e.settled_usd === null || e.settled_usd === undefined).length,
      unknown_billing_reserved_usd: ledger.filter((e) => e.settled_usd === null || e.settled_usd === undefined).reduce((a, e) => a + e.reserved_usd, 0),
    },
    warmups: rows.filter((r) => r.warmup).map((r) => ({ run_id: r.run_id, status: r.reported_status, verified: r.verified_pass, task_ms: r.task_ms })),
    overall: summarize(measured),
    by_mode: Object.fromEntries(modes.map((m) => [m, summarize(measured.filter((r) => r.mode === m))])),
    by_case_mode: Object.fromEntries(cases.map((c) => [c, Object.fromEntries(modes.map((m) => {
      const rs = measured.filter((r) => r.case === c && r.mode === m);
      return [m, { n: rs.length, pass: rs.filter((r) => r.verified_pass).length, statuses: rs.map((r) => r.reported_status), categories: rs.map((r) => r.failure_category), task_ms_median: median(rs.map((r) => r.task_ms)), steps_median: median(rs.map((r) => r.decision_steps)) }];
    }))])),
    paired: modes.length === 2 ? paired(measured) : null,
    negative_controls: rows.some((r) => r.negative_control_pass !== null && r.negative_control_pass !== undefined) ? { run: rows.filter((r) => r.negative_control_pass !== null).length, wrongly_passed: rows.filter((r) => r.negative_control_pass === true).map((r) => r.run_id) } : null,
  };
  writeFileSync(join(dir, "summary.json"), JSON.stringify(summary, null, 1));

  const L = [];
  L.push(`# ${summary.label}`, "", `Results directory: \`${dir}\`. Stop: ${stop?.stop_reason ?? "unknown"}; unexecuted slots: ${stop?.unexecuted?.length ?? "unknown"}.`, "");
  L.push("| Mode | Attempts | Verified | Completion (Wilson 95%) | Claimed | False success | Task median / p95 (ms) | Startup median (ms) | Actions median | Jev calls | Est. cost (USD) | Cost / verified success |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [m, s] of [...Object.entries(summary.by_mode), ["all", summary.overall]]) {
    L.push(`| ${m} | ${s.attempts} | ${s.verified_passes} | ${pct(s.completion_rate)} (${ci(s.completion_wilson95)}) | ${s.claimed_successes} | ${s.false_successes} (${pct(s.false_success_rate_of_claims)} of claims) | ${s.task_ms_median ?? "n/a"} / ${s.task_ms_p95 ?? "n/a"} | ${s.startup_ms_median ?? "n/a"} | ${s.executed_actions_median ?? "n/a"} | ${s.jev_calls_total ?? "unknown"} | ${s.total_cost_usd_est === null ? "unknown" : s.total_cost_usd_est.toFixed(4)} | ${s.cost_per_verified_success_usd_est === null ? "undefined" : s.cost_per_verified_success_usd_est.toFixed(5)} |`);
  }
  L.push("", "Failure categories (all measured attempts): " + Object.entries(summary.overall.failure_categories).map(([k, v]) => `${k}=${v}`).join(", "), "");
  L.push("| Case | " + modes.map((m) => `${m} pass/n`).join(" | ") + " | " + modes.map((m) => `${m} categories`).join(" | ") + " |", "|---|" + modes.map(() => "---|").join("") + modes.map(() => "---|").join(""));
  for (const [c, byMode] of Object.entries(summary.by_case_mode)) {
    L.push(`| ${c} | ` + modes.map((m) => `${byMode[m].pass}/${byMode[m].n}`).join(" | ") + " | " + modes.map((m) => byMode[m].categories.join(", ")).join(" | ") + " |");
  }
  if (summary.paired) {
    const p = summary.paired;
    L.push("", `Paired headed/headless: ${p.pairs} pairs; both pass ${p.both_pass}, headed only ${p.headed_only}, headless only ${p.headless_only}, both fail ${p.both_fail}; exact McNemar p=${p.mcnemar_exact_p ?? "n/a"}; reported-status agreement ${pct(p.reported_status_agreement)}; median task-time difference (headed − headless) ${p.task_ms_diff_headed_minus_headless_median ?? "n/a"} ms.${p.small_sample ? " Small sample (fewer than 30 pairs): treat as descriptive." : ""}`);
  }
  if (summary.negative_controls) L.push("", `Negative controls (claimed success on the untouched initial state): ${summary.negative_controls.run} run, wrongly passed: ${summary.negative_controls.wrongly_passed.length ? summary.negative_controls.wrongly_passed.join(", ") : "none"}.`);
  L.push("", `Ledger (all phases including warm-ups): ${summary.all_phases_ledger.outbound_requests} outbound requests, settled estimate $${summary.all_phases_ledger.settled_usd_est.toFixed(4)}, ${summary.all_phases_ledger.unknown_billing_requests} with unknown billing (reserved $${summary.all_phases_ledger.unknown_billing_reserved_usd.toFixed(4)}).`, "");
  writeFileSync(join(dir, "summary.md"), L.join("\n"));
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error("usage: node benchmarks/report.mjs <results-dir>"); process.exit(2); }
  writeReport(process.argv[2]);
  console.log(readFileSync(join(process.argv[2], "summary.md"), "utf8"));
}
