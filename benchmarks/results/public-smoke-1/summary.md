# live-public, real Jev loop

Results directory: `/Users/mikekaranja/Projects/tools/browser-automation/jev-browser/benchmarks/results/public-smoke-1`. Stop: schedule complete; unexecuted slots: 0.

| Mode | Attempts | Verified | Completion (Wilson 95%) | Claimed | False success | Task median / p95 (ms) | Startup median (ms) | Actions median | Jev calls | Est. cost (USD) | Cost / verified success |
|---|---|---|---|---|---|---|---|---|---|---|---|
| headless | 9 | 8 | 88.9% (56.5%–98.0%) | 9 | 1 (11.1% of claims) | 4014 / 6489 | 422 | 1 | 20 | 0.0117 | 0.00146 |
| headed | 9 | 9 | 100.0% (70.1%–100.0%) | 9 | 0 (0.0% of claims) | 3593 / 10170 | 499 | 1 | 22 | 0.0114 | 0.00127 |
| all | 18 | 17 | 94.4% (74.2%–99.0%) | 18 | 1 (5.6% of claims) | 3967 / 10170 | 447.5 | 1 | 42 | 0.0231 | 0.00136 |

Failure categories (all measured attempts): pass=17, false_success=1

| Case | headless pass/n | headed pass/n | headless categories | headed categories |
|---|---|---|---|---|
| live-wiki-search | 3/3 | 3/3 | pass, pass, pass | pass, pass, pass |
| live-wiki-coffee-espresso | 3/3 | 3/3 | pass, pass, pass | pass, pass, pass |
| live-example-iana | 2/3 | 3/3 | pass, false_success, pass | pass, pass, pass |

Paired headed/headless: 9 pairs; both pass 8, headed only 1, headless only 0, both fail 0; exact McNemar p=1; reported-status agreement 100.0%; median task-time difference (headed − headless) 66 ms. Small sample (fewer than 30 pairs): treat as descriptive.

Ledger (all phases including warm-ups): 52 outbound requests, settled estimate $0.0263, 0 with unknown billing (reserved $0.0000).
