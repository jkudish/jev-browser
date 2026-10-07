import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { askJudgment, InvalidJudgmentAnswer, resolveTransport } from "../dist/provider.js";
import { navigate } from "../dist/library.js";

const signal = new AbortController().signal;
const questions = { item: { type: "choice", criteria: { alpha: "A", beta: "B" } }, yes: { type: "noul" } };
const answers = { item: { type: "choice", choice: "beta", probabilities: { alpha: 0.2, beta: 0.8 } }, yes: { type: "noul", noul: 0.7 } };
const input = { state: { title: "Example" }, questions, model: "jev-latest", signal };
const usage = { input_tokens: 13, output_tokens: 3 };
const carrier = (override = {}) => ({ name: "fixture", ask: async () => ({ answers, usage, model: "effective", ...override }) });
// judgment_calls is the 1.0 name; jev_calls must carry the identical value through 1.x.
function assertCalls(result, n) {
  assert.equal(result.usage.judgment_calls, n);
  assert.equal(result.usage.jev_calls, n);
}

const builtin = (name, env) => resolveTransport({ ...env, DISCERN_PROVIDER: name });

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
    assert.equal(resolveTransport({ ...all, DISCERN_PROVIDER: name.toUpperCase() }).name, name);
  }
  assert.equal(resolveTransport({ DISCERN_CLOUDFLARE_API_TOKEN: "pref", CLOUDFLARE_ACCOUNT_ID: "account" }).name, "cloudflare");
  // Legacy JEV_ names alias their DISCERN_ names through 1.x.
  assert.equal(resolveTransport({ JEV_CLOUDFLARE_API_TOKEN: "pref", CLOUDFLARE_ACCOUNT_ID: "account" }).name, "cloudflare");
  assert.equal(resolveTransport({ ...all, JEV_PROVIDER: "vercel" }).name, "vercel");
  assert.throws(() => resolveTransport({ ...all, DISCERN_PROVIDER: "typo" }), /Unknown DISCERN_PROVIDER/);
  assert.throws(() => resolveTransport({}), (error) => ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "CLOUDFLARE_API_TOKEN", "DISCERN_CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "AI_GATEWAY_API_KEY"].every((name) => error.message.includes(name)));
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
    assert.throws(() => resolveTransport({ ...env, DISCERN_PROVIDER: name }), (error) => {
      assert.match(error.message, pattern);
      assert.ok(error.message.startsWith(`DISCERN_PROVIDER=${name}`));
      assert.ok(!error.message.includes("secret"));
      return true;
    });
  }
  assert.equal(resolveTransport({ OPENROUTER_API_KEY: "wrong-secret", AI_GATEWAY_API_KEY: "ai-secret" }).name, "vercel");
  assert.equal(resolveTransport({ CLOUDFLARE_ACCOUNT_ID: "account-secret", AI_GATEWAY_API_KEY: "ai-secret" }).name, "vercel");
});

test("facade validates the complete answer contract before usage can be credited", async () => {
  const good = await askJudgment(carrier(), input);
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
    await assert.rejects(() => askJudgment(carrier({ answers: mutated }), input), (error) => error instanceof InvalidJudgmentAnswer && error.message.includes(`provider fixture question ${id}`) && reason.test(error.message));
  }
  await assert.rejects(() => askJudgment(carrier({ usage: { input_tokens: -1, output_tokens: 0 } }), input), /provider fixture question <response>.*usage/);
  await assert.rejects(() => askJudgment(carrier({ usage: { input_tokens: undefined, output_tokens: 0 } }), input), /provider fixture question <response>.*usage/);
  await assert.rejects(() => askJudgment(carrier({ model: " " }), input), /provider fixture question <response>.*model/);
  const tied = { ...answers, item: { ...answers.item, choice: "alpha", probabilities: { alpha: 0.4995, beta: 0.5005 }, confidence: 0 } };
  assert.equal((await askJudgment(carrier({ answers: tied }), input)).answers.item.choice, "alpha");
  const score = { state: null, model: "jev", signal, questions: { rank: { type: "score", criteria: ["poor", "good", "great"] } } };
  const scoreReply = { rank: { type: "score", score: 2, probabilities: { "0": 0.1, "1": 0.2, "2": 0.7 }, confidence: null } };
  assert.equal((await askJudgment(carrier({ answers: scoreReply }), score)).answers.rank.score, 2);
  await assert.rejects(() => askJudgment(carrier({ answers: { rank: { ...scoreReply.rank, score: 3 } } }), score), /question rank.*score is outside/);
});

test("transport failure stays distinct from invalid answers and cancellation keeps its reason", async () => {
  const failed = { name: "fixture", ask: async () => { throw new Error("body-secret"); } };
  await assert.rejects(() => askJudgment(failed, input), (error) => !(error instanceof InvalidJudgmentAnswer) && /request failed/.test(error.message) && !/body-secret/.test(error.message));

  const controller = new AbortController();
  const reason = new Error("deadline-exceeded");
  const cancelled = { name: "fixture", ask: async () => { controller.abort(reason); throw reason; } };
  await assert.rejects(() => askJudgment(cancelled, { ...input, signal: controller.signal }), (error) => error === reason);
});

test("TypeSafe client binds key and base URL at creation, forwards request and cancellation", async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ answers, usage });
  }, async () => {
    const transport = builtin("typesafe", { TYPESAFE_API_KEY: "ts-secret", TYPESAFE_BASE_URL: "https://local.typesafe.test" });
    const reply = await askJudgment(transport, input);
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
    await assert.rejects(() => askJudgment(builtin("typesafe", { TYPESAFE_API_KEY: "ts-secret" }), input), (error) => !/body-secret|ts-secret/.test(error.message) && /request failed/.test(error.message) && !(error instanceof InvalidJudgmentAnswer));
  });
});

test("OpenRouter maps latest and pinned slugs, sends exact envelope and redacts HTTP errors", async () => {
  const calls = [];
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json(calls.length === 1 ? { answers, usage, model: "typesafe/jev-1.13-20260917" } : { answers, usage });
  }, async () => {
    const transport = builtin("openrouter", { OPENROUTER_API_KEY: "sk-or-secret" });
    assert.equal((await askJudgment(transport, input)).model, "typesafe/jev-1.13-20260917");
    assert.equal((await askJudgment(transport, { ...input, model: "typesafe/jev-1.12" })).model, "typesafe/jev-1.12");
    assert.equal((await askJudgment(transport, { ...input, model: "~typesafe/jev-latest" })).model, "~typesafe/jev-latest");
    assert.equal(calls[0].url, "https://openrouter.ai/api/alpha/decisions");
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer sk-or-secret", "Content-Type": "application/json", "HTTP-Referer": "https://github.com/jkudish/discern-agent-tools", "X-Title": "discern", "X-OpenRouter-Title": "discern" });
    assert.ok(calls[0].init.signal instanceof AbortSignal && !calls[0].init.signal.aborted);
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "~typesafe/jev-latest", state: input.state, questions });
    assert.deepEqual(calls.map((call) => JSON.parse(call.init.body).model), ["~typesafe/jev-latest", "typesafe/jev-1.12", "~typesafe/jev-latest"]);
  });
  for (const response of [new Response("body-secret", { status: 403 }), new Response("body-secret", { status: 200 })]) {
    await withFetch(async () => response, async () => {
      await assert.rejects(() => askJudgment(builtin("openrouter", { OPENROUTER_API_KEY: "sk-or-secret" }), input), (error) => /request failed/.test(error.message) && !/body-secret|sk-or-secret/.test(error.message));
    });
  }
  await withFetch(async () => Response.json({ usage }), async () => {
    await assert.rejects(() => askJudgment(builtin("openrouter", { OPENROUTER_API_KEY: "sk-or-secret" }), input), /question <response>.*answers/);
  });
  await withFetch(async () => { throw new Error("body-secret sk-or-secret"); }, async () => {
    await assert.rejects(() => askJudgment(builtin("openrouter", { OPENROUTER_API_KEY: "sk-or-secret" }), input), (error) => /request failed/.test(error.message) && !/body-secret|sk-or-secret/.test(error.message) && !(error instanceof InvalidJudgmentAnswer));
  });
});

test("Cloudflare token priority, double envelope, state, usage, and safe errors", async () => {
  const calls = [];
  const env = { CLOUDFLARE_API_TOKEN: "low-secret", JEV_CLOUDFLARE_API_TOKEN: "high-secret", CLOUDFLARE_ACCOUNT_ID: "account" };
  await withFetch(async (url, init) => {
    calls.push({ url, init });
    return Response.json({ success: true, result: { state: "Completed", result: { answers, usage, model: "typesafe/jev" } } });
  }, async () => {
    const transport = builtin("cloudflare", env);
    assert.deepEqual((await askJudgment(transport, input)).usage, usage);
    assert.equal(calls[0].url, "https://api.cloudflare.com/client/v4/accounts/account/ai/run");
    assert.deepEqual(calls[0].init.headers, { Authorization: "Bearer high-secret", "Content-Type": "application/json" });
    assert.ok(calls[0].init.signal instanceof AbortSignal && !calls[0].init.signal.aborted);
    assert.deepEqual(JSON.parse(calls[0].init.body), { model: "typesafe/jev", input: { state: input.state, questions } });
    assert.equal((await transport.ask({ ...input, model: "typesafe/jev-1.2" })).model, "typesafe/jev");
    assert.equal(JSON.parse(calls[1].init.body).model, "typesafe/jev-1.2");
  });
  for (const response of [new Response("body-secret", { status: 401 }), Response.json({ success: false, errors: ["body-secret"] }), Response.json({ result: { state: "Failed body-secret" } }), new Response("body-secret", { status: 200 })]) {
    await withFetch(async () => response, async () => {
      await assert.rejects(() => askJudgment(builtin("cloudflare", env), input), (error) => /request failed/.test(error.message) && !/body-secret|high-secret|low-secret/.test(error.message));
    });
  }
  await withFetch(async () => { throw new Error("body-secret high-secret"); }, async () => {
    await assert.rejects(() => askJudgment(builtin("cloudflare", env), input), (error) => /request failed/.test(error.message) && !/body-secret|high-secret/.test(error.message) && !(error instanceof InvalidJudgmentAnswer));
  });
});

test("Vercel forwards evaluation request and adapts boolean and confidence", async () => {
  let call;
  const raw = { item: { type: "choice", choice: "beta", probabilities: { alpha: 0.2, beta: 0.8 } }, yes: { type: "boolean", probability: 0.7 } };
  const result = { answers: raw, usage: { inputTokens: 13, outputTokens: 3 }, providerMetadata: { typesafe: { confidence: { item: 0.92 } } } };
  const transport = builtin("vercel", { AI_GATEWAY_API_KEY: "ai-secret" });
  await withFetch(async (url, init) => { call = { url, init }; return Response.json(result); }, async () => {
    const reply = await askJudgment(transport, input);
    assert.equal(reply.model, "typesafe-ai/jev");
    assert.deepEqual(reply.usage, usage);
    assert.equal(call.url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    assert.ok(call.init.signal instanceof AbortSignal && !call.init.signal.aborted);
    assert.equal(call.init.headers.Authorization, "Bearer ai-secret");
    assert.equal(call.init.headers["ai-model-id"], "typesafe-ai/jev");
    assert.deepEqual(JSON.parse(call.init.body), { state: input.state, questions: { item: { type: "choice", criteria: questions.item.criteria }, yes: { type: "boolean" } } });
    assert.deepEqual(reply.answers, { item: { ...answers.item, confidence: 0.92 }, yes: answers.yes });
  });
  await withFetch(async () => Response.json({ ...result, answers: { item: raw.item } }), async () => {
    await assert.rejects(() => askJudgment(transport, input), (error) => error instanceof InvalidJudgmentAnswer && /question yes.*missing answer/.test(error.message));
  });
  await withFetch(async () => new Response("body-secret", { status: 403 }), async () => {
    await assert.rejects(() => askJudgment(transport, input), (error) => !(error instanceof InvalidJudgmentAnswer) && /request failed/.test(error.message) && !/body-secret|ai-secret/.test(error.message));
  });
});

test("all adapters distinguish absent usage from malformed containers and present null counters", async () => {
  const vercelAnswers = { item: answers.item, yes: { type: "boolean", probability: answers.yes.noul } };
  for (const [name, field, run] of [
    ["typesafe", "input_tokens", (wire) => withFetch(async () => Response.json({ answers, ...wire }), () => askJudgment(builtin("typesafe", { TYPESAFE_API_KEY: "ts-secret" }), input))],
    ["openrouter", "input_tokens", (wire) => withFetch(async () => Response.json({ answers, ...wire }), () => askJudgment(builtin("openrouter", { OPENROUTER_API_KEY: "sk-or-secret" }), input))],
    ["cloudflare", "input_tokens", (wire) => withFetch(async () => Response.json({ result: { state: "Completed", result: { answers, ...wire } } }), () => askJudgment(builtin("cloudflare", { CLOUDFLARE_API_TOKEN: "cf-secret", CLOUDFLARE_ACCOUNT_ID: "account" }), input))],
    ["vercel", "inputTokens", (wire) => withFetch(async () => Response.json({ answers: vercelAnswers, ...wire }), () => askJudgment(builtin("vercel", { AI_GATEWAY_API_KEY: "ai-secret" }), input))],
  ]) {
    assert.deepEqual((await run({})).usage, { input_tokens: 0, output_tokens: 0 }, name);
    assert.deepEqual((await run({ usage: {} })).usage, { input_tokens: 0, output_tokens: 0 }, name);
    const invalidCases = [{ usage: "body-secret" }, { usage: null }, { usage: { [field]: null } }];
    for (const invalid of invalidCases) {
      await assert.rejects(() => run(invalid), (error) => /usage|request failed/.test(error.message) && !error.message.includes("body-secret"), `${name}: ${JSON.stringify(invalid)}`);
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
      const previous = process.env.DISCERN_PROVIDER;
      process.env.DISCERN_PROVIDER = "invalid-forced-name";
      let result;
      try { result = await navigate({ task: "Choose Premium", page, transport, allowTyping: false, maxSteps: 1, screenshot: "none" }); }
      finally { if (previous === undefined) delete process.env.DISCERN_PROVIDER; else process.env.DISCERN_PROVIDER = previous; }
      assert.equal(calls.length, 2);
      assert.equal(result.judgment_provider, "custom-carrier");
      assert.equal(result.jev_provider, result.judgment_provider);
      assert.equal(result.model, "custom-model");
      if (broken) {
        assert.equal(result.status, "error");
        assert.match(result.error, /question option.*outside criteria/);
        assertCalls(result, 1);
        assert.equal(result.steps.length, 0);
        assert.equal(await page.locator("select").inputValue(), "a");
      } else {
        assert.equal(result.status, "max_steps");
        assertCalls(result, 2);
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
    assertCalls(primary, 0);
    assert.equal(primary.judgment_provider, null);
    assert.equal(primary.jev_provider, null);
    assert.equal(await page.locator("select").inputValue(), "a");
  } finally { await browser.close(); }
});

test("cost estimate uses the answering carrier's input price", async (t) => {
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
    await page.setContent("<p>Nothing to do here</p>");
    const cost = async (name) => {
      const result = await navigate({
        task: "Read the page", page, allowTyping: false, maxSteps: 1, screenshot: "none",
        transport: { name, ask: async (request) => ({ answers: { action: { type: "choice", choice: "scroll_down", probabilities: Object.fromEntries(Object.keys(request.questions.action.criteria).map((key) => [key, key === "scroll_down" ? 1 : 0])) }, goal_done: { type: "noul", noul: 0 }, stuck: { type: "noul", noul: 0 } }, usage: { input_tokens: 1_000_000, output_tokens: 0 }, model: "m" }) },
      });
      assertCalls(result, 1);
      assert.equal(result.judgment_provider, name);
      assert.equal(result.jev_provider, name);
      return result.usage.est_cost_usd;
    };
    assert.equal(await cost("openai"), 0.1);
    assert.equal(await cost("typesafe"), 0.042);
  } finally { await browser.close(); }
});

test("navigate() reads legacy JEV_BROWSER_* names through DISCERN_ and rejects a conflict without values", async (t) => {
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
  const saved = { JEV_BROWSER_MODEL: process.env.JEV_BROWSER_MODEL, DISCERN_BROWSER_MODEL: process.env.DISCERN_BROWSER_MODEL };
  const restore = () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  try {
    const page = await browser.newPage();
    await page.setContent("<p>Nothing to do here</p>");
    const models = [];
    const transport = {
      name: "fixture",
      ask: async (request) => {
        models.push(request.model);
        return { answers: { action: { type: "choice", choice: "scroll_down", probabilities: Object.fromEntries(Object.keys(request.questions.action.criteria).map((key) => [key, key === "scroll_down" ? 1 : 0])) }, goal_done: { type: "noul", noul: 0 }, stuck: { type: "noul", noul: 0 } }, usage, model: request.model };
      },
    };
    const run = () => navigate({ task: "Read the page", page, transport, allowTyping: false, maxSteps: 1, screenshot: "none" });

    delete process.env.DISCERN_BROWSER_MODEL;
    process.env.JEV_BROWSER_MODEL = "legacy-model-name";
    await run();
    assert.equal(models.at(-1), "legacy-model-name");
    assert.equal(process.env.DISCERN_BROWSER_MODEL, undefined, "the library path must not modify process.env");

    process.env.DISCERN_BROWSER_MODEL = "current-model-name";
    process.env.JEV_BROWSER_MODEL = "current-model-name";
    await run();
    assert.equal(models.at(-1), "current-model-name", "equal values are not a conflict");
    process.env.JEV_BROWSER_MODEL = "";
    await run();
    assert.equal(models.at(-1), "current-model-name", "an empty legacy value counts as unset");

    process.env.JEV_BROWSER_MODEL = "conflicting-model-value";
    const callsBefore = models.length;
    await assert.rejects(run, (error) => {
      assert.match(error.message, /DISCERN_BROWSER_MODEL and JEV_BROWSER_MODEL/);
      assert.ok(!error.message.includes("current-model-name") && !error.message.includes("conflicting-model-value"));
      return true;
    });
    assert.equal(models.length, callsBefore, "a conflict is rejected before any judgment call");
  } finally {
    restore();
    await browser.close();
  }
});

test("transport failures, including the deadline, are run errors rather than invalid judgments", async () => {
  for (const status of [429, 503]) {
    const failing = { name: "fixture", ask: async () => { throw Object.assign(new Error("x"), { status }); } };
    await assert.rejects(() => askJudgment(failing, input), (error) => !(error instanceof InvalidJudgmentAnswer) && /HTTP/.test(error.message));
  }
  const hanging = { name: "fixture", ask: (request) => new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason))) };
  const { ask } = await import("@jkudish/discern-agent-tools");
  const result = await ask({ ...input, signal: new AbortController().signal }, { transport: hanging, timeoutMs: 20 });
  assert.equal(result.code, "timeout");
});
