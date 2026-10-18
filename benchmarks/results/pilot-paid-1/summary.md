# synthetic-local, real Jev loop

Results directory: `/Users/mikekaranja/Projects/tools/browser-automation/jev-browser/benchmarks/results/pilot-paid-1`. Stop: schedule complete; unexecuted slots: 0.

| Mode | Attempts | Verified | Completion (Wilson 95%) | Claimed | False success | Task median / p95 (ms) | Startup median (ms) | Actions median | Jev calls | Est. cost (USD) | Cost / verified success |
|---|---|---|---|---|---|---|---|---|---|---|---|
| headed | 2 | 2 | 100.0% (34.2%–100.0%) | 2 | 0 (0.0% of claims) | 4655 / 5504 | 488 | 2.5 | 7 | 0.0006 | 0.00028 |
| headless | 2 | 2 | 100.0% (34.2%–100.0%) | 2 | 0 (0.0% of claims) | 4433.5 / 5939 | 423 | 2.5 | 7 | 0.0006 | 0.00028 |
| all | 4 | 4 | 100.0% (51.0%–100.0%) | 4 | 0 (0.0% of claims) | 4655 / 5939 | 471 | 2.5 | 14 | 0.0011 | 0.00028 |

Failure categories (all measured attempts): pass=4

| Case | headed pass/n | headless pass/n | headed categories | headless categories |
|---|---|---|---|---|
| search-keyboard | 1/1 | 1/1 | pass | pass |
| form-no-submit | 1/1 | 1/1 | pass | pass |

Paired headed/headless: 2 pairs; both pass 2, headed only 0, headless only 0, both fail 0; exact McNemar p=n/a; reported-status agreement 100.0%; median task-time difference (headed − headless) 221.5 ms. Small sample (fewer than 30 pairs): treat as descriptive.

Ledger (all phases including warm-ups): 22 outbound requests, settled estimate $0.0011, 0 with unknown billing (reserved $0.0000).
