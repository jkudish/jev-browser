import assert from "node:assert/strict";
import test from "node:test";
import { confidentEnough, openrouterSlug, shouldFallthrough, modelLadder, strikeLimit, garbageConfidence, excerptChars, pricePerMtokIn, browserViewport } from "../dist/ladder.js";

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

test("default ladder starts with perplexity", () => {
  assert.equal(modelLadder({}).length, 6);
  assert.equal(modelLadder({})[0], "perplexity/pplx-decider-v1-27b");
  assert.deepEqual(modelLadder({ JEV_BROWSER_MODELS: "a/b, c/d" }), ["a/b", "c/d"]);
});

test("env overrides with sane defaults", () => {
  assert.equal(strikeLimit({}), 2);
  assert.equal(strikeLimit({ JEV_BROWSER_STRIKE_LIMIT: "5" }), 5);
  assert.equal(garbageConfidence({}), 0.1);
  assert.equal(garbageConfidence({ JEV_BROWSER_GARBAGE_CONFIDENCE: "0.05" }), 0.05);
  assert.equal(excerptChars({}), 1500);
  assert.equal(excerptChars({ JEV_BROWSER_EXCERPT_CHARS: "800" }), 800);
  assert.equal(pricePerMtokIn({}), 0.042);
  assert.equal(pricePerMtokIn({ JEV_BROWSER_PRICE_PER_MTOK_IN: "0" }), 0);
  assert.deepEqual(browserViewport({}), { width: 1024, height: 640 });
  assert.deepEqual(browserViewport({ JEV_BROWSER_VIEWPORT: "1600x1400" }), { width: 1600, height: 1400 });
  assert.deepEqual(browserViewport({ JEV_BROWSER_VIEWPORT: "bogus" }), { width: 1024, height: 640 });
});
