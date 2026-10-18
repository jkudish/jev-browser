# synthetic-local, harness validation only (oracle); not a measurement of Jev

Results directory: `/Users/mikekaranja/Projects/tools/browser-automation/jev-browser/benchmarks/results/validate-oracle-1`. Stop: schedule complete; unexecuted slots: 0.

| Mode | Attempts | Verified | Completion (Wilson 95%) | Claimed | False success | Task median / p95 (ms) | Startup median (ms) | Actions median | Jev calls | Est. cost (USD) | Cost / verified success |
|---|---|---|---|---|---|---|---|---|---|---|---|
| headed | 12 | 12 | 100.0% (75.7%–100.0%) | 11 | 0 (0.0% of claims) | 297 / 3448 | 655.5 | 0 | 0 | 0.0000 | 0.00000 |
| headless | 12 | 12 | 100.0% (75.7%–100.0%) | 11 | 0 (0.0% of claims) | 230.5 / 3937 | 623.5 | 0 | 0 | 0.0000 | 0.00000 |
| all | 24 | 24 | 100.0% (86.2%–100.0%) | 22 | 0 (0.0% of claims) | 265.5 / 3448 | 646 | 0 | 0 | 0.0000 | 0.00000 |

Failure categories (all measured attempts): pass=24

| Case | headed pass/n | headless pass/n | headed categories | headless categories |
|---|---|---|---|---|
| unavailable-target | 1/1 | 1/1 | pass | pass |
| pagination | 1/1 | 1/1 | pass | pass |
| form-no-submit | 1/1 | 1/1 | pass | pass |
| search-keyboard | 1/1 | 1/1 | pass | pass |
| nav-new-tab | 1/1 | 1/1 | pass | pass |
| offscreen-lazy | 1/1 | 1/1 | pass | pass |
| filter-sort | 1/1 | 1/1 | pass | pass |
| stop-before-submit | 1/1 | 1/1 | pass | pass |
| extract-annual-price | 1/1 | 1/1 | pass | pass |
| dropdowns | 1/1 | 1/1 | pass | pass |
| ambiguous-save | 1/1 | 1/1 | pass | pass |
| delayed-content | 1/1 | 1/1 | pass | pass |

Paired headed/headless: 12 pairs; both pass 12, headed only 0, headless only 0, both fail 0; exact McNemar p=n/a; reported-status agreement 100.0%; median task-time difference (headed − headless) 78 ms. Small sample (fewer than 30 pairs): treat as descriptive.

Negative controls (claimed success on the untouched initial state): 24 run, wrongly passed: none.

Ledger (all phases including warm-ups): 0 outbound requests, settled estimate $0.0000, 0 with unknown billing (reserved $0.0000).
