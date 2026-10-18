# synthetic-local, harness validation only (mock-random); not a measurement of Jev

Results directory: `/Users/mikekaranja/Projects/tools/browser-automation/jev-browser/benchmarks/results/validate-mock-random-3`. Stop: schedule complete; unexecuted slots: 0.

| Mode | Attempts | Verified | Completion (Wilson 95%) | Claimed | False success | Task median / p95 (ms) | Startup median (ms) | Actions median | Jev calls | Est. cost (USD) | Cost / verified success |
|---|---|---|---|---|---|---|---|---|---|---|---|
| headed | 12 | 1 | 8.3% (1.5%–35.4%) | 0 | 0 (n/a of claims) | 3343 / 4107 | 464.5 | 10 | 116 | 0.0000 | 0.00000 |
| headless | 12 | 1 | 8.3% (1.5%–35.4%) | 0 | 0 (n/a of claims) | 3324.5 / 4182 | 417.5 | 10 | 116 | 0.0000 | 0.00000 |
| all | 24 | 2 | 8.3% (2.3%–25.8%) | 0 | 0 (n/a of claims) | 3343 / 4107 | 435.5 | 10 | 232 | 0.0000 | 0.00000 |

Failure categories (all measured attempts): agent_max_steps=18, typing_unavailable=1, unsafe_write=3, pass=2

| Case | headed pass/n | headless pass/n | headed categories | headless categories |
|---|---|---|---|---|
| delayed-content | 0/1 | 0/1 | agent_max_steps | agent_max_steps |
| form-no-submit | 0/1 | 0/1 | typing_unavailable | unsafe_write |
| dropdowns | 0/1 | 0/1 | agent_max_steps | agent_max_steps |
| search-keyboard | 0/1 | 0/1 | agent_max_steps | agent_max_steps |
| pagination | 0/1 | 0/1 | unsafe_write | agent_max_steps |
| nav-new-tab | 0/1 | 0/1 | unsafe_write | agent_max_steps |
| ambiguous-save | 0/1 | 0/1 | agent_max_steps | agent_max_steps |
| stop-before-submit | 0/1 | 0/1 | agent_max_steps | agent_max_steps |
| offscreen-lazy | 0/1 | 0/1 | agent_max_steps | agent_max_steps |
| extract-annual-price | 0/1 | 0/1 | agent_max_steps | agent_max_steps |
| filter-sort | 0/1 | 0/1 | agent_max_steps | agent_max_steps |
| unavailable-target | 1/1 | 1/1 | pass | pass |

Paired headed/headless: 12 pairs; both pass 1, headed only 0, headless only 0, both fail 11; exact McNemar p=n/a; reported-status agreement 100.0%; median task-time difference (headed − headless) 0 ms. Small sample (fewer than 30 pairs): treat as descriptive.

Ledger (all phases including warm-ups): 0 outbound requests, settled estimate $0.0000, 0 with unknown billing (reserved $0.0000).
