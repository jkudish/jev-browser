import assert from "node:assert/strict";
import test from "node:test";
import { confidentEnough, openrouterSlug, shouldFallthrough, modelLadder } from "../dist/ladder.js";

test("slash ids are not prefixed", () => {
  assert.equal(openrouterSlug("inception/mercury-decide:free"), "inception/mercury-decide:free");
  assert.equal(openrouterSlug("typesafe/jev-1.13"), "typesafe/jev-1.13");
  assert.equal(openrouterSlug("jev-latest"), "typesafe/jev-1.13");
});

test("401 does not fall through; 429 and 404 do", () => {
  assert.equal(shouldFallthrough("request_failed", "HTTP 401"), false);
  assert.equal(shouldFallthrough("request_failed", "HTTP 403"), false);
  assert.equal(shouldFallthrough("rate_limited", "HTTP 429"), true);
  assert.equal(shouldFallthrough("request_failed", "OpenRouter decisions API HTTP 404 (request failed; 12 response bytes)"), true);
  assert.equal(shouldFallthrough("configuration_error", "no key"), false);
});

test("confidence floor accepts only a high enough number", () => {
  assert.equal(confidentEnough(0.43, 0.7), false);
  assert.equal(confidentEnough(null, 0.7), false);
  assert.equal(confidentEnough(0.7, 0.7), true);
});

test("default ladder starts with the free model", () => {
  assert.equal(modelLadder({}).length, 7);
  assert.equal(modelLadder({})[0], "inception/mercury-decide:free");
  assert.deepEqual(modelLadder({ JEV_BROWSER_MODELS: "a/b, c/d" }), ["a/b", "c/d"]);
});
