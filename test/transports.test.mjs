import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { askJev, resolveTransport } from "../dist/provider.js";
import { typesafe } from "../dist/transports/typesafe.js";
import { openrouter } from "../dist/transports/openrouter.js";
import { cloudflare } from "../dist/transports/cloudflare.js";
import { createVercelDriver, adaptVercelAnswers } from "../dist/transports/vercel.js";
import { navigate } from "../dist/library.js";

const signal = new AbortController().signal;
const questions = { item: { type: "choice", criteria: { alpha: "A", beta: "B" } }, yes: { type: "noul" } };
const answers = { item: { type: "choice", choice: "beta", probabilities: { alpha: 0.2, beta: 0.8 } }, yes: { type: "noul", noul: 0.7 } };
const input = { state: { title: "Example" }, questions, model: "jev-latest", signal };
const usage = { input_tokens: 13, output_tokens: 3 };
const carrier = (override = {}) => ({ name: "fixture", ask: async () => ({ answers, usage, model: "effective", ...override }) });

async function withFetch(fn, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test("registry auto-detects in precedence order and explicit names select only themselves", () => {
  const all = { TYPESAFE_API_KEY: "ts-secret", OPENROUTER_API_KEY: "sk-or-secret", CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "account", AI_GATEWAY_API_KEY: "ai-secret" };
  for (const [removed, expected] of [
    [[], "typesafe"],
    [["TYPESAFE_API_KEY"], "openrouter"],
    [["TYPESAFE_API_KEY", "OPENROUTER_API_KEY"], "cloudflare"],
    [["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN"], "vercel"],
  ]) {
    const env = { ...all };
    for (const key of removed) delete env[key];
    assert.equal(resolveTransport(env).name, expected);
  }
  for (const name of ["typesafe", "openrouter", "cloudflare", "vercel"]) {
    assert.equal(resolveTransport({ ...all, JEV_PROVIDER: name.toUpperCase() }).name, name);
  }
  assert.equal(resolveTransport({ JEV_CLOUDFLARE_API_TOKEN: "pref", CLOUDFLARE_ACCOUNT_ID: "account" }).name, "cloudflare");
  assert.throws(() => resolveTransport({ ...all, JEV_PROVIDER: "typo" }), /Unknown JEV_PROVIDER/);
  assert.throws(() => resolveTransport({}), (error) => ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN", "JEV_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "AI_GATEWAY_API_KEY"].every((name) => error.message.includes(name)));
});

test("forced credentials reject every missing or invalid variant without leaking values", () => {
  const cases = [
    ["typesafe", {}, /TYPESAFE_API_KEY/],
    ["openrouter", {}, /OPENROUTER_API_KEY/],
    ["openrouter", { OPENROUTER_API_KEY: "wrong-secret" }, /sk-or-/],
    ["cloudflare", {}, /CLOUDFLARE_ACCOUNT_ID/],
    ["cloudflare", { CLOUDFLARE_API_TOKEN: "cf-secret" }, /CLOUDFLARE_ACCOUNT_ID/],
    ["cloudflare", { CLOUDFLARE_ACCOUNT_ID: "account-secret" }, /CLOUDFLARE_API_TOKEN/],
    ["cloudflare", { JEV_CLOUDFLARE_API_TOKEN: "cf-secret" }, /CLOUDFLARE_ACCOUNT_ID/],
    ["vercel", {}, /AI_GATEWAY_API_KEY/],
  ];
  for (const [name, env, pattern] of cases) {
    assert.throws(() => resolveTransport({ ...env, JEV_PROVIDER: name }), (error) => {
      assert.match(error.message, pattern);
      assert.ok(error.message.startsWith(`JEV_PROVIDER=${name}`));
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  assert.equal(resolveTransport({ OPENROUTER_API_KEY: "wrong-secret", AI_GATEWAY_API_KEY: "ai-secret" }).name, "vercel");
  assert.equal(resolveTransport({ CLOUDFLARE_ACCOUNT_ID: "account-secret", AI_GATEWAY_API_KEY: "ai-secret" }).name, "vercel");
});

test("facade validates the complete answer contract before usage can be credited", async () => {
  const good = await askJev(carrier(), input);
  assert.equal(good.provider, "fixture");
  assert.equal(good.answers.item.confidence, null);
  assert.equal(good.model, "effective");
  for (const [mutated, id, reason] of [
    [{ item: answers.item }, "yes", /missing answer/],
    [{ ...answers, item: { ...answers.item, type: "noul" } }, "item", /wrong type/],
    [{ ...answers, item: { ...answers.item, choice: "gamma" } }, "item", /outside criteria/],
    [{ ...answers, item: { ...answers.item, choice: "alpha" } }, "item", /not a distribution maximum/],
    [{ ...answers, item: { ...answers.item, probabilities: { alpha: NaN, beta: 0.8 } } }, "item", /finite probabilities/],
    [{ ...answers, item: { ...answers.item, probabilities: { alpha: 0.1, beta: 0.7 } } }, "item", /approximately 1/],
    [{ ...answers, item: { ...answers.item, probabilities: { alpha: 0.2, beta: 0.7, extra: 0.1 } } }, "item", /exactly the criteria/],
    [{ ...answers, item: { ...answers.item, confidence: Infinity } }, "item", /confidence/],
    [{ ...answers, yes: { type: "noul", noul: 1.1 } }, "yes", /noul/],
  ]) {
    await assert.rejects(() => askJev(carrier({ answers: mutated }), input), (error) => error.message.includes(`provider fixture question ${id}`) && reason.test(error.message));
  }
  await assert.rejects(() => askJev(carrier({ usage: { input_tokens: -1, output_tokens: 0 } }), input), /provider fixture question <response>.*usage/);
  await assert.rejects(() => askJev(carrier({ usage: { input_tokens: undefined, output_tokens: 0 } }), input), /provider fixture question <response>.*usage/);
  await assert.rejects(() => askJev(carrier({ model: " " }), input), /provider fixture question <response>.*model/);
  const tied = { ...answers, item: { ...answers.item, choice: "alpha", probabilities: { alpha: 0.4995, beta: 0.5005 }, confidence: 0 } };
  assert.equal((await askJev(carrier({ answers: tied }), input)).answers.item.choice, "alpha");
  const score = { state: null, model: "jev", signal, questions: { rank: { type: "score", criteria: ["poor", "good", "great"] } } };
  const scoreReply = { rank: { type: "score", score: 2, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 }, confidence: null } };
  assert.equal((await askJev(carrier({ answers: scoreReply }), score)).answers.rank.score, 2);
  await assert.rejects(() => askJev(carrier({ answers: { rank: { ...scoreReply.rank, score: 3 } } }), score), /question rank.*score is outside/);
});

test("TypeSafe client binds key and base URL at creation, forwards request and cancellation", async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ answers, usage });
  }, async () => {
    const transport = typesafe.create({ TYPESAFE_API_KEY: "ts-secret", TYPESAFE_BASE_URL: "https://local.typesafe.test" });
    const reply = await askJev(transport, input);
    assert.deepEqual(reply.usage, usage);
    assert.equal(reply.model, "jev-latest");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://local.typesafe.test/v1/systemone");
    assert.equal(calls[0].init.headers.Authorization, "Bearer ts-secret");
    assert.deepEqual(JSON.parse(calls[0].init.body), { state: input.state, questions, model: "jev-latest" });
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    assert.equal(calls[0].init.signal.aborted, false);
  });
  await withFetch(async () => Response.json({ error: "body-secret" }, { status: 400 }), async () => {
    await assert.rejects(() => typesafe.create({ TYPESAFE_API_KEY: "ts-secret" }).ask(input), (error) => !/body-secret|ts-secret/.test(error.message) && /TypeSafe API HTTP 400/.test(error.message));
  });
});

test("OpenRouter maps latest and pinned slugs, sends exact envelope and redacts HTTP errors", async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ answers, usage });
  }, async () => {
    const transport = openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" });
    assert.equal((await askJev(transport, input)).model, "typesafe/jev-1.13");
    assert.equal((await askJev(transport, { ...input, model: "typesafe/jev-1.12" })).model, "typesafe/jev-1.12");
    assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer sk-or-secret", "Content-Type": "application/json", "HTTP-Referer": "https://github.com/jkudish/jev-browser", "X-Title": "jev-browser", "X-OpenRouter-Title": "jev-browser" });
    assert.equal(calls[0].init.signal, signal);
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "typesafe/jev-1.13", state: input.state, questions });
  });
  for (const response of [new Response("body-secret", { status: 403 }), new Response("body-secret", { status: 200 })]) {
    await withFetch(async () => response, async () => {
      await assert.rejects(() => openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" }).ask(input), (error) => /OpenRouter decisions API HTTP/.test(error.message) && !/body-secret|sk-or-secret/.test(error.message));
    });
  }
  await withFetch(async () => Response.json({ usage }), async () => {
    await assert.rejects(() => askJev(openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" }), input), /question <response>.*answers/);
  });
  await withFetch(async () => { throw new Error("body-secret sk-or-secret"); }, async () => {
    await assert.rejects(() => openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" }).ask(input), (error) => /HTTP unavailable.*network error/.test(error.message) && !/body-secret|sk-or-secret/.test(error.message));
  });
});

test("Cloudflare token priority, double envelope, state, usage, and safe errors", async () => {
  const calls = [];
  const env = { CLOUDFLARE_API_TOKEN: "low-secret", JEV_CLOUDFLARE_API_TOKEN: "high-secret", CLOUDFLARE_ACCOUNT_ID: "account" };
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ success: true, result: { state: "Completed", result: { answers, usage, model: "typesafe/jev" } } });
  }, async () => {
    const transport = cloudflare.create(env);
    assert.deepEqual((await askJev(transport, input)).usage, usage);
    assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/account/ai/run");
    assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer high-secret", "Content-Type": "application/json" });
    assert.equal(calls[0].init.signal, signal);
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "typesafe/jev", input: { state: input.state, questions } });
    assert.equal((await transport.ask({ ...input, model: "typesafe/jev-1.2" })).model, "typesafe/jev");
    assert.equal(JSON.parse(calls[1].init.body).model, "typesafe/jev-1.2");
  });
  for (const response of [new Response("body-secret", { status: 401 }), Response.json({ success: false, errors: ["body-secret"] }), Response.json({ result: { state: "Failed body-secret" } }), new Response("body-secret", { status: 200 })]) {
    await withFetch(async () => response, async () => {
      await assert.rejects(() => cloudflare.create(env).ask(input), (error) => /Cloudflare AI run HTTP/.test(error.message) && !/body-secret|high-secret|low-secret/.test(error.message));
    });
  }
  await withFetch(async () => { throw new Error("body-secret high-secret"); }, async () => {
    await assert.rejects(() => cloudflare.create(env).ask(input), (error) => /HTTP unavailable.*network error/.test(error.message) && !/body-secret|high-secret/.test(error.message));
  });
});

test("Vercel factory forwards evaluate request and pure adaptation preserves confidence", async () => {
  let call;
  const raw = { item: { type: "choice", choice: "beta", probabilities: { alpha: 0.2, beta: 0.8 } }, yes: { type: "boolean", probability: 0.7 } };
  const result = { answers: raw, usage: { inputTokens: 13, outputTokens: 3 }, providerMetadata: { typesafe: { confidence: { item: 0.92 } } } };
  const factory = createVercelDriver(async (args) => { call = args; return result; });
  const reply = await askJev(factory.create({ AI_GATEWAY_API_KEY: "ai-secret" }), input);
  assert.equal(reply.model, "typesafe-ai/jev");
  assert.deepEqual(reply.usage, usage);
  assert.equal(call.abortSignal, signal);
  assert.equal(call.model.modelId, "typesafe-ai/jev");
  assert.deepEqual(call.questions, { item: { type: "choice", instructions: undefined, criteria: questions.item.criteria }, yes: { type: "boolean", instructions: undefined, criteria: undefined } });
  assert.deepEqual(reply.answers, { item: { ...answers.item, confidence: 0.92 }, yes: answers.yes });
  assert.deepEqual(adaptVercelAnswers({ yes: raw.yes, rank: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8 } } }, {}), { yes: answers.yes, rank: { type: "score", score: 1, probabilities: { "0": 0.2, "1": 0.8 }, confidence: null } });
  const failing = createVercelDriver(async () => { throw Object.assign(new Error("body-secret"), { statusCode: 403 }); });
  await assert.rejects(() => failing.create({ AI_GATEWAY_API_KEY: "ai-secret" }).ask(input), (error) => /Vercel AI Gateway HTTP 403/.test(error.message) && !/body-secret|ai-secret/.test(error.message));
  const malformed = createVercelDriver(async () => ({ ...result, answers: { item: raw.item } }));
  await assert.rejects(() => askJev(malformed.create({ AI_GATEWAY_API_KEY: "ai-secret" }), input), /provider vercel question yes.*missing answer/);
});

test("all adapters distinguish absent usage from malformed containers and present null counters", async () => {
  const vercelAnswers = { item: answers.item, yes: { type: "boolean", probability: answers.yes.noul } };
  for (const [name, field, run] of [
    ["typesafe", "input_tokens", (wire) => withFetch(async () => Response.json({ answers, ...wire }), () => askJev(typesafe.create({ TYPESAFE_API_KEY: "ts-secret" }), input))],
    ["openrouter", "input_tokens", (wire) => withFetch(async () => Response.json({ answers, ...wire }), () => askJev(openrouter.create({ OPENROUTER_API_KEY: "sk-or-secret" }), input))],
    ["cloudflare", "input_tokens", (wire) => withFetch(async () => Response.json({ result: { state: "Completed", result: { answers, ...wire } } }), () => askJev(cloudflare.create({ CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "account" }), input))],
    ["vercel", "inputTokens", (wire) => askJev(createVercelDriver(async () => ({ answers: vercelAnswers, ...wire })).create({ AI_GATEWAY_API_KEY: "ai-secret" }), input)],
  ]) {
    assert.deepEqual((await run({})).usage, { input_tokens: 0, output_tokens: 0 }, name);
    assert.deepEqual((await run({ usage: {} })).usage, { input_tokens: 0, output_tokens: 0 }, name);
    const invalidCases = [{ usage: "body-secret" }, { usage: null }, { usage: { [field]: null } }];
    if (name === "vercel") invalidCases.push({ usage: { [field]: undefined } }); // JSON drops undefined properties on the HTTP drivers.
    for (const invalid of invalidCases) {
      await assert.rejects(() => run(invalid), (error) => /usage/.test(error.message) && !error.message.includes("body-secret"), `${name}: ${JSON.stringify(invalid)}`);
    }
  }
});

test("injected transport drives both call sites and malformed second-stage answer executes nothing", async (t) => {
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (String(error).includes("Executable doesn't exist")) {
      t.skip("Playwright browser binary is not installed");
      return;
    }
    throw error;
  }
  try {
    const page = await browser.newPage();
    await page.setContent('<label for="tier">Tier</label><select id="tier"><option value="a">Basic</option><option value="b">Premium</option></select>');
    for (const broken of [false, true]) {
      const calls = [];
      const transport = {
        name: "custom-carrier",
        async ask(request) {
          calls.push(request);
          const reply = request.questions.option
            ? { option: broken ? { type: "choice", choice: "missing", probabilities: { o0: 0.1, o1: 0.9 } } : { type: "choice", choice: "o1", probabilities: { o0: 0.1, o1: 0.9 } } }
            : { action: { type: "choice", choice: "select_e1", probabilities: Object.fromEntries(Object.keys(request.questions.action.criteria).map((key) => [key, key === "select_e1" ? 1 : 0])) }, goal_done: { type: "noul", noul: 0 }, stuck: { type: "noul", noul: 0 } };
          return { answers: reply, usage, model: "custom-model" };
        },
      };
      const previous = process.env.JEV_PROVIDER;
      process.env.JEV_PROVIDER = "invalid-forced-name";
      let result;
      try { result = await navigate({ task: "Choose Premium", page, transport, allowTyping: false, maxSteps: 1, screenshot: "none" }); }
      finally { if (previous === undefined) delete process.env.JEV_PROVIDER; else process.env.JEV_PROVIDER = previous; }
      assert.equal(calls.length, 2);
      assert.equal(result.jev_provider, "custom-carrier");
      assert.equal(result.model, "custom-model");
      if (broken) {
        assert.equal(result.status, "error");
        assert.match(result.error, /question option.*outside criteria/);
        assert.equal(result.usage.jev_calls, 1);
        assert.equal(result.steps.length, 0);
        assert.equal(await page.locator("select").inputValue(), "a");
      } else {
        assert.equal(result.status, "max_steps");
        assert.equal(result.usage.jev_calls, 2);
        assert.equal(result.steps[0].executed_action, "select_e1");
        assert.equal(await page.locator("select").inputValue(), "b");
        await page.locator("select").selectOption("a");
      }
    }
    const refused = await navigate({
      task: "Choose Premium", page, allowTyping: false, maxSteps: 1, screenshot: "none",
      transport: { name: "custom-carrier", async ask(request) {
        if (request.questions.option) throw new Error("body-secret");
        return { answers: { action: { type: "choice", choice: "select_e1", probabilities: Object.fromEntries(Object.keys(request.questions.action.criteria).map((key) => [key, key === "select_e1" ? 1 : 0])) }, goal_done: { type: "noul", noul: 0 }, stuck: { type: "noul", noul: 0 } }, usage, model: "custom-model" };
      } },
    });
    assert.equal(refused.status, "error");
    assert.match(refused.error, /question option: request failed/);
    assert.ok(!refused.error.includes("body-secret"));
    assert.equal(refused.steps.length, 0);
    assert.equal(await page.locator("select").inputValue(), "a");
    const primary = await navigate({
      task: "Choose Premium", page, allowTyping: false, maxSteps: 1, screenshot: "none",
      transport: { name: "custom-carrier", ask: async () => ({ answers: { action: { type: "choice", choice: "select_e1", probabilities: {} } }, usage, model: "custom-model" }) },
    });
    assert.equal(primary.status, "error");
    assert.match(primary.error, /question goal_done.*missing answer/);
    assert.equal(primary.steps.length, 0);
    assert.equal(primary.usage.jev_calls, 0);
    assert.equal(await page.locator("select").inputValue(), "a");
  } finally { await browser.close(); }
});
