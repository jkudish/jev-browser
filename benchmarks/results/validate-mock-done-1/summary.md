# synthetic-local, harness validation only (mock-done); not a measurement of Jev

Results directory: `benchmarks/results/validate-mock-done-1`. Stop: schedule complete; unexecuted slots: 0.

| Mode | Attempts | Verified | Completion (Wilson 95%) | Claimed | False success | Task median / p95 (ms) | Startup median (ms) | Actions median | Jev calls | Est. cost (USD) | Cost / verified success |
|---|---|---|---|---|---|---|---|---|---|---|---|
| headed | 12 | 0 | 0.0% (0.0%–24.3%) | 12 | 12 (100.0% of claims) | 210.5 / 777 | 632.5 | 0 | 12 | 0.0000 | undefined |
| headless | 12 | 0 | 0.0% (0.0%–24.3%) | 12 | 12 (100.0% of claims) | 122 / 178 | 499.5 | 0 | 12 | 0.0000 | undefined |
| all | 24 | 0 | 0.0% (0.0%–13.8%) | 24 | 24 (100.0% of claims) | 166.5 / 711 | 548 | 0 | 24 | 0.0000 | undefined |

Failure categories (all measured attempts): false_success=24

| Case | headed pass/n | headless pass/n | headed categories | headless categories |
|---|---|---|---|---|
| delayed-content | 0/1 | 0/1 | false_success | false_success |
| form-no-submit | 0/1 | 0/1 | false_success | false_success |
| dropdowns | 0/1 | 0/1 | false_success | false_success |
| search-keyboard | 0/1 | 0/1 | false_success | false_success |
| pagination | 0/1 | 0/1 | false_success | false_success |
| nav-new-tab | 0/1 | 0/1 | false_success | false_success |
| ambiguous-save | 0/1 | 0/1 | false_success | false_success |
| stop-before-submit | 0/1 | 0/1 | false_success | false_success |
| offscreen-lazy | 0/1 | 0/1 | false_success | false_success |
| extract-annual-price | 0/1 | 0/1 | false_success | false_success |
| filter-sort | 0/1 | 0/1 | false_success | false_success |
| unavailable-target | 0/1 | 0/1 | false_success | false_success |

Paired headed/headless: 12 pairs; both pass 0, headed only 0, headless only 0, both fail 12; exact McNemar p=n/a; reported-status agreement 100.0%; median task-time difference (headed − headless) 87.5 ms. Small sample (fewer than 30 pairs): treat as descriptive.

Ledger (all phases including warm-ups): 0 outbound requests, settled estimate $0.0000, 0 with unknown billing (reserved $0.0000).
