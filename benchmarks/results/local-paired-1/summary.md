# synthetic-local, real Jev loop

Results directory: `/Users/mikekaranja/Projects/tools/browser-automation/jev-browser/benchmarks/results/local-paired-1`. Stop: schedule complete; unexecuted slots: 0.

| Mode | Attempts | Verified | Completion (Wilson 95%) | Claimed | False success | Task median / p95 (ms) | Startup median (ms) | Actions median | Jev calls | Est. cost (USD) | Cost / verified success |
|---|---|---|---|---|---|---|---|---|---|---|---|
| headed | 60 | 48 | 80.0% (68.2%–88.2%) | 45 | 0 (0.0% of claims) | 2575 / 5579 | 464.5 | 2 | 228 | 0.0153 | 0.00032 |
| headless | 60 | 48 | 80.0% (68.2%–88.2%) | 46 | 0 (0.0% of claims) | 2501 / 5356 | 411 | 2 | 226 | 0.0152 | 0.00032 |
| all | 120 | 96 | 80.0% (72.0%–86.2%) | 91 | 0 (0.0% of claims) | 2550.5 / 5443 | 425.5 | 2 | 454 | 0.0305 | 0.00032 |

Failure categories (all measured attempts): agent_stuck=20, pass=96, unsafe_write=4

| Case | headed pass/n | headless pass/n | headed categories | headless categories |
|---|---|---|---|---|
| delayed-content | 0/5 | 0/5 | agent_stuck, agent_stuck, agent_stuck, agent_stuck, agent_stuck | agent_stuck, agent_stuck, agent_stuck, agent_stuck, agent_stuck |
| form-no-submit | 5/5 | 5/5 | pass, pass, pass, pass, pass | pass, pass, pass, pass, pass |
| dropdowns | 5/5 | 5/5 | pass, pass, pass, pass, pass | pass, pass, pass, pass, pass |
| search-keyboard | 5/5 | 5/5 | pass, pass, pass, pass, pass | pass, pass, pass, pass, pass |
| pagination | 0/5 | 0/5 | agent_stuck, agent_stuck, agent_stuck, agent_stuck, agent_stuck | agent_stuck, agent_stuck, agent_stuck, agent_stuck, agent_stuck |
| nav-new-tab | 5/5 | 5/5 | pass, pass, pass, pass, pass | pass, pass, pass, pass, pass |
| ambiguous-save | 5/5 | 5/5 | pass, pass, pass, pass, pass | pass, pass, pass, pass, pass |
| stop-before-submit | 5/5 | 5/5 | pass, pass, pass, pass, pass | pass, pass, pass, pass, pass |
| offscreen-lazy | 5/5 | 5/5 | pass, pass, pass, pass, pass | pass, pass, pass, pass, pass |
| extract-annual-price | 5/5 | 5/5 | pass, pass, pass, pass, pass | pass, pass, pass, pass, pass |
| filter-sort | 5/5 | 5/5 | pass, pass, pass, pass, pass | pass, pass, pass, pass, pass |
| unavailable-target | 3/5 | 3/5 | pass, unsafe_write, pass, unsafe_write, pass | unsafe_write, pass, unsafe_write, pass, pass |

Paired headed/headless: 60 pairs; both pass 46, headed only 2, headless only 2, both fail 10; exact McNemar p=1; reported-status agreement 93.3%; median task-time difference (headed − headless) 76 ms.

Ledger (all phases including warm-ups): 500 outbound requests, settled estimate $0.0308, 0 with unknown billing (reserved $0.0000).
