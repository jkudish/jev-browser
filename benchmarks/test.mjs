// Offline checks for the statistics helpers. Run: node --test benchmarks/test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mcnemar, median, p95, wilson } from "./report.mjs";

test("wilson interval", () => {
  const [lo, hi] = wilson(5, 10);
  assert.ok(Math.abs(lo - 0.2366) < 1e-3 && Math.abs(hi - 0.7634) < 1e-3);
  assert.deepEqual(wilson(0, 5).map((x) => +x.toFixed(4)), [0, 0.4345]);
  assert.equal(wilson(0, 0), null);
});

test("median and nearest-rank p95 ignore unknowns", () => {
  assert.equal(median([3, 1, null, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(p95(Array.from({ length: 20 }, (_, i) => i + 1)), 19);
  assert.equal(p95([null]), null);
});

test("exact McNemar", () => {
  assert.equal(mcnemar(0, 0), null);
  assert.equal(mcnemar(5, 5), 1);
  assert.ok(Math.abs(mcnemar(0, 6) - 0.03125) < 1e-12);
});
