// End-to-end: spawn the built server over stdio and run real navigation tasks.
// Skipped unless TYPESAFE_API_KEY is set. Requires Playwright Chromium.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium } from "playwright";
import { navigate } from "../dist/navigate.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const hasKey = Boolean(process.env.TYPESAFE_API_KEY);

// Minimal deterministic site: a multi-field form with a submit button (the
// button carries no type attribute, so it defaults to submit inside the form),
// and a search box with no submit button at all. The /find search box is a
// plain text input on purpose: only input[type=search]/role=searchbox get the
// one-action search_eN, so this one must stay reachable the explicit way,
// type then submit_eN pressing Enter. /lookup carries a real type=search
// input, which is the page the search_eN degradation tests run against.
async function startFixtureSite() {
  const requests = [];
  const page = (title, body) =>
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.pathname === "/join") {
      res.end(
        page(
          "Join the club",
          `<form action="/joined" method="get">
             <input name="first" type="text" aria-label="First name" placeholder="First name">
             <input name="city" type="text" aria-label="City" placeholder="City">
             <button>Join</button>
           </form>`,
        ),
      );
    } else if (url.pathname === "/joined") {
      res.end(page("Application received", `<p>first=${url.searchParams.get("first") ?? ""} city=${url.searchParams.get("city") ?? ""}</p>`));
    } else if (url.pathname === "/lookup") {
      res.end(
        page(
          "Lookup",
          `<form action="/found" method="get">
             <input name="q" type="search" aria-label="Search drinks">
           </form>`,
        ),
      );
    } else if (url.pathname === "/find") {
      res.end(
        page(
          "Find a drink",
          `<form action="/found" method="get">
             <input name="q" type="text" aria-label="Search" placeholder="Search for a drink">
           </form>`,
        ),
      );
    } else if (url.pathname === "/pay") {
      res.end(
        page(
          "Pay your tab",
          `<form action="/paid" method="get">
             <input name="email" type="text" aria-label="Email" placeholder="Email">
             <input type="submit" value="Pay now" aria-label="   " title="Confirm payment">
           </form>`,
        ),
      );
    } else if (url.pathname === "/paid") {
      res.end(page("Payment sent", `<p>email=${url.searchParams.get("email") ?? ""}</p>`));
    } else if (url.pathname === "/rsvp") {
      res.end(
        page(
          "RSVP",
          `<form action="/rsvped" method="get">
             <input name="guest" type="text" aria-label="Guest name" placeholder="Guest name">
             <input type="submit" title="Confirm attendance">
           </form>`,
        ),
      );
    } else if (url.pathname === "/rsvped") {
      res.end(page("See you there", `<p>guest=${url.searchParams.get("guest") ?? ""}</p>`));
    } else if (url.pathname === "/found") {
      res.end(page("Results", `<p>Ristretto: a short shot of espresso (${url.searchParams.get("q") ?? ""})</p>`));
    } else if (url.pathname === "/locked") {
      // A Cloudflare-style managed challenge interstitial, modelled on a real
      // 403 response: challenge title plus three body markers, static.
      res.end(
        page(
          "Just a moment...",
          `<p>www.example.com Performing security verification. This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.</p><p>Ray ID: a3f56bcf9b4e5a49 Performance and Security by Cloudflare Privacy</p>`,
        ),
      );
    } else if (url.pathname === "/hardblock") {
      // A Cloudflare hard-block page: no interactive challenge, just denial.
      res.end(page("Attention Required! | Cloudflare", `<p>Sorry, you have been blocked. Error 1020 Access denied. Ray ID: 9abc123</p>`));
    } else if (url.pathname === "/clearing") {
      // A challenge that auto-passes: after 1.2s the page paints real content,
      // like a JS challenge that clears itself without interaction.
      res.end(`<!doctype html><html><head><title>Just a moment...</title></head><body><p>Performing security verification. Verify you are human.</p><script>setTimeout(() => { document.title = "Welcome in"; document.body.innerHTML = "<h1>Welcome in</h1><p>The real page after the challenge cleared.</p>"; }, 1200);</script></body></html>`);
    } else if (url.pathname === "/locklate") {
      // A normal page whose only control navigates to the challenge: with
      // maxSteps 1, the click executes, the budget ends, and the challenge is
      // first visible on the FINAL page. The final pass must flip the status.
      res.end(page("Start here", `<p>An ordinary page.</p><a href="/locked">Continue</a>`));
    } else if (url.pathname === "/lockclearing") {
      // Same shape as /locklate, but the destination challenge clears itself
      // (see /clearing): the final pass must wait it out and report the real
      // page, not a wall that has already gone.
      res.end(page("Start here", `<p>An ordinary page.</p><a href="/clearing">Continue</a>`));
    } else if (url.pathname === "/mitigated") {
      // A clean page delivered with Cloudflare's cf-mitigated header, as a
      // passed challenge looks in the response log: the header alone must
      // never stop a run, only annotate it.
      res.setHeader("cf-mitigated", "challenge");
      res.end(page("Coffee menu", `<p>Espresso, ristretto, and flat whites are all available today.</p>`));
    } else {
      res.statusCode = 404;
      res.end(page("Not found", ""));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { requests, baseUrl: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

// A local OpenAI chat-completions shaped endpoint standing in for the typing
// provider: deterministic replies, offline runs, and a record of what the
// typing generator actually asked for.
async function startFakeTypingAPI(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          created: 0,
          model: "fake-typing-model",
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function withClient(fn, extraEnv = {}) {
  const client = new Client({ name: "jev-browser-e2e", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY ?? "",
      ...(process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {}),
      ...(process.env.JEV_BROWSER_TYPE_MODEL ? { JEV_BROWSER_TYPE_MODEL: process.env.JEV_BROWSER_TYPE_MODEL } : {}),
      ...extraEnv,
    },
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function payload(result) {
  const block = result.content?.find((b) => b.type === "text");
  assert.ok(block, "tool returned no text content");
  return JSON.parse(block.text);
}

test("lists the tool", { skip: !hasKey }, async () => {
  await withClient(async (client) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["jev_navigate"]);
  });
});

test("click-navigation: Coffee -> Espresso", { skip: !hasKey }, async () => {
  await withClient(async (client) => {
    const result = await client.callTool(
      {
        name: "jev_navigate",
        arguments: {
          task: "Navigate from the Coffee article to the Wikipedia article about Espresso and stop when you are on it",
          start_url: "https://en.wikipedia.org/wiki/Coffee",
          max_steps: 8,
          max_seconds: 120,
        },
      },
      undefined,
      { timeout: 240_000 },
    );
    const body = payload(result);
    assert.ok(["done", "goal_achieved"].includes(body.status), `status was ${body.status}: ${JSON.stringify(body.steps)}`);
    assert.match(body.final_url, /\/wiki\/Espresso/);
    assert.ok(body.usage.jev_calls >= 2);
    assert.ok(Array.isArray(body.console_events));
    // The screenshot travels as a separate MCP image block, not in the JSON.
    assert.ok(result.content.some((b) => b.type === "image"), "expected a screenshot image block");
  });
});

test("typed search: find the Ristretto article", { skip: !hasKey }, async () => {
  await withClient(async (client) => {
    const result = await client.callTool(
      {
        name: "jev_navigate",
        arguments: {
          task: "Search Wikipedia for the espresso-based drink called Ristretto and stop when you are on that article",
          start_url: "https://en.wikipedia.org/wiki/Main_Page",
          max_steps: 8,
          max_seconds: 120,
        },
      },
      undefined,
      { timeout: 240_000 },
    );
    const body = payload(result);
    assert.ok(["done", "goal_achieved"].includes(body.status), `status was ${body.status}: ${JSON.stringify(body.steps)}`);
    assert.match(body.final_url, /Ristretto/);
  });
});

test("clean termination on a hard page (informational)", { skip: !hasKey }, async () => {
  await withClient(async (client) => {
    const result = await client.callTool(
      {
        name: "jev_navigate",
        arguments: {
          task: "Find the TypeSafe AI blog post that introduces Jev and stop on that page",
          start_url: "https://duckduckgo.com/",
          max_steps: 6,
          max_seconds: 90,
        },
      },
      undefined,
      { timeout: 180_000 },
    );
    const body = payload(result);
    assert.ok(
      ["done", "goal_achieved", "stuck", "max_steps", "timeout"].includes(body.status),
      `unexpected status ${body.status}`,
    );
    // DOM-first extraction should see DuckDuckGo's search input even though its
    // accessibility tree does not expose one. DuckDuckGo intermittently serves
    // a bot-challenge page (50x-tq.html) or its marketing homepage, where the
    // search box sits below a wall of promo links and the model may never reach
    // it; when either variant lands, clean termination is the most this test
    // can demand.
    const typedOk = body.steps.some((s) => /(typed|searched) "/.test(s.detail ?? "") && !s.action_error);
    const degraded =
      /50x|anomaly|challenge/i.test(body.final_url ?? "") ||
      /50x|Protection\. Privacy/i.test(body.final_title ?? "");
    assert.ok(typedOk || degraded, "expected successful typing or a degraded DuckDuckGo page");
  });
});

// Regression for issue #1: <label for> forms with no placeholder must surface
// their text inputs in the action space. Pre-fix, this page offered zero
// typeable elements and the agent declared done without acting.
test("label-for inputs appear in the action space and can be typed into", { skip: !hasKey }, async () => {
  const { createServer } = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const fixture = readFileSync(fileURLToPath(new URL("./fixtures/login.html", import.meta.url)));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const typing = await startFakeTypingAPI("tomsmith");
  try {
    await withClient(
      async (client) => {
      const result = await client.callTool(
        {
          name: "jev_navigate",
          arguments: {
            task: "Type the word tomsmith into the username input field and stop",
            start_url: `http://127.0.0.1:${port}/`,
            max_steps: 5,
            max_seconds: 60,
          },
        },
        undefined,
        { timeout: 120_000 },
      );
      const body = payload(result);
      // The username input is the only typeable element (password fields are
      // excluded by design), so any executed type action proves the fix; the
      // outcome naming the label[for] text (not the id/name) pins resolution.
      const typed = body.steps.find((s) => /^type_/.test(s.executed_action ?? "") && !s.action_error);
      assert.ok(typed, `no type action executed: ${JSON.stringify(body.steps.map((s) => [s.proposed_action, s.executed_action]))}`);
      assert.match(typed.outcome ?? "", /typed into "Username"/);
      assert.ok(!body.steps.some((s) => /Password/.test(s.outcome ?? "")), "a password input must not be offered without a source, even with a role override");
      assert.ok(["done", "goal_achieved"].includes(body.status), `status was ${body.status}`);
      // Clean run: no degradation, and the typing configuration actually used
      // is reported verbatim (provider label plus the model override).
      assert.equal(body.degraded, false);
      assert.deepEqual(body.warnings, []);
      assert.equal(body.typing_provider, "compatible-endpoint");
      assert.equal(body.typing_model, "fake-typing-model");
      assert.match(typed.detail ?? "", /^typed "tomsmith" via compatible-endpoint$/);
      },
      {
        JEV_BROWSER_TYPE_BASE_URL: `${typing.baseUrl}/v1`,
        JEV_BROWSER_TYPE_MODEL: "fake-typing-model",
      },
    );
  } finally {
    typing.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("native selects choose by DOM index, even with filtered blank options", { skip: !hasKey }, async () => {
  const { createServer } = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const fixture = readFileSync(fileURLToPath(new URL("./fixtures/select.html", import.meta.url)));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await withClient(async (client) => {
      const result = await client.callTool(
        {
          name: "jev_navigate",
          arguments: {
            task: "Choose Business as the cabin class in the dropdown, then stop",
            start_url: `http://127.0.0.1:${port}/`,
            max_steps: 5,
            max_seconds: 60,
          },
        },
        undefined,
        { timeout: 120_000 },
      );
      const body = payload(result);
      const selected = body.steps.find((s) => /^select_/.test(s.executed_action ?? "") && !s.action_error);
      assert.ok(selected, `no select action executed: ${JSON.stringify(body.steps.map((s) => [s.proposed_action, s.executed_action, s.action_error]))}`);
      assert.match(selected.detail ?? "", /selected "Business"/);
      // The page echoes the chosen value: picking the right DOM option (not
      // the one at the model-list offset) proves index-based selection holds
      // after the blank first option was filtered from the model's list.
      assert.ok(body.page.content.includes("SELECTED: business"), `wrong option selected: ${body.page.content}`);
      assert.ok(["done", "goal_achieved"].includes(body.status), `status was ${body.status}`);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── Password fill ────────────────────────────────────────────────────────────
import { mkdtemp, mkdir, writeFile, chmod, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SECRET = "e2e 'p\"w'{&q=1"; // contains ', " and { so the aria snapshot serializer must both backslash-escape and YAML-quote the echoed name

async function serveFixture(name) {
  const { createServer } = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const fixture = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

function assertNoSecret(result, body) {
  const haystack = JSON.stringify(body) + JSON.stringify(result.content ?? []);
  // Raw plus the encodings a page realistically echoes back: percent,
  // form-URL-encoded, and the partial/full HTML-entity serializations.
  const echoes = [
    SECRET,
    encodeURIComponent(SECRET),
    new URLSearchParams({ x: SECRET }).toString().slice(2),
    SECRET.replace(/&/g, "&amp;"),
    SECRET.replace(/([&<>"'])/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c),
    // aria snapshots: the renderer JSON-escapes quotes and backslashes, then
    // YAML single-quote-doubles the assembled value. Both stages compose, so
    // assert each stage alone and the composed form.
    SECRET.replace(/'/g, "''"),
    SECRET.replace(/(["\\])/g, "\\$1"),
    SECRET.replace(/(["\\])/g, "\\$1").replace(/'/g, "''"),
  ];
  for (const echo of echoes) {
    assert.ok(!haystack.includes(echo), `the password leaked into the tool result (${echo === SECRET ? "raw" : "encoded"})`);
    // A slice taken before redaction would leave half a variant behind: check
    // both halves of every representation as well as the whole.
    const half = Math.ceil(echo.length / 2);
    assert.ok(!haystack.includes(echo.slice(0, half)), `a prefix of the password leaked into the tool result`);
    assert.ok(!haystack.includes(echo.slice(-half)), `a suffix of the password leaked into the tool result`);
  }
}

test("password fill: handoff file consumed, filled, never submitted, never leaked", { skip: !hasKey }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-handoff-e2e-"));
  await chmod(dir, 0o700);
  const file = join(dir, "pw.e2e");
  await writeFile(file, SECRET, { mode: 0o600 });
  const fixture = await serveFixture("password.html");
  try {
    await withClient(
      async (client) => {
        const result = await client.callTool(
          {
            name: "jev_navigate",
            arguments: {
              task: "Fill the password field with the configured password, then stop",
              start_url: `${fixture.origin}/`,
              max_steps: 5,
              max_seconds: 60,
              password_file: file,
            },
          },
          undefined,
          { timeout: 120_000 },
        );
        const body = payload(result);
        const fill = body.steps.find((s) => /^fill_password_/.test(s.executed_action ?? "") && !s.action_error);
        assert.ok(fill, `no fill executed: ${JSON.stringify(body.steps.map((s) => [s.proposed_action, s.executed_action, s.action_error]))}`);
        assert.match(fill.detail ?? "", /filled password into "Password"; not submitted/);
        assert.equal(body.password_filled, true);
        assert.equal(body.screenshot_suppressed, "credential-fill");
        assert.ok(!result.content.some((b) => b.type === "image"), "screenshot must be suppressed after a fill");
        assert.ok(body.page.content.includes("PW_FILLED"), "the page should show the fill marker");
        assert.ok(!body.page.content.includes("SUBMITTED"), "the form must never be submitted by a fill");
        // The fixture echoes the value into a visible link, an attribute, and
        // console.error: every reflection must come back redacted, in the
        // payload and in captured console events.
        assert.ok(body.page.content.includes("mirror: [REDACTED]"), "a reflected echo must be redacted in the payload");
        const echo = (body.console_events ?? []).find((e) => e.type === "console_error");
        assert.ok(echo, "the fixture's console.error echo should be captured");
        assert.match(echo.text, /echo: \[REDACTED\]/);
        assertNoSecret(result, body);
      },
      { JEV_BROWSER_PASSWORD_ORIGIN: fixture.origin, JEV_BROWSER_HANDOFF_DIR: dir },
    );
    await assert.rejects(() => stat(file), /ENOENT/); // consumed at run start
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("password fill: aria snapshots of an echoing page are scrubbed too", { skip: !hasKey }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-handoff-e2e-"));
  await chmod(dir, 0o700);
  const file = join(dir, "pw.aria");
  await writeFile(file, SECRET, { mode: 0o600 });
  const fixture = await serveFixture("password.html");
  try {
    await withClient(
      async (client) => {
        const result = await client.callTool(
          {
            name: "jev_navigate",
            arguments: {
              task: "Fill the password field with the configured password, then stop",
              start_url: `${fixture.origin}/`,
              max_steps: 5,
              max_seconds: 60,
              format: "aria",
              password_file: file,
            },
          },
          undefined,
          { timeout: 120_000 },
        );
        const body = payload(result);
        const fill = body.steps.find((s) => /^fill_password_/.test(s.executed_action ?? "") && !s.action_error);
        assert.ok(fill, "no fill executed");
        assert.equal(body.password_filled, true);
        // The fixture reflects the value into the mirror link's aria-label,
        // so the aria snapshot is produced from a page that holds it: the
        // YAML serializer's output must come back scrubbed.
        assert.ok(body.page.content.includes("PW_FILLED"), "the page should show the fill marker");
        assert.ok(body.page.content.includes("[REDACTED]"), "the aria-label echo must be redacted in the snapshot");
        assertNoSecret(result, body);
      },
      { JEV_BROWSER_PASSWORD_ORIGIN: fixture.origin, JEV_BROWSER_HANDOFF_DIR: dir },
    );
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("password fill: wrong-origin pages are refused and the value never lands", { skip: !hasKey }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-handoff-e2e-"));
  await chmod(dir, 0o700);
  const file = join(dir, "pw.e2e");
  await writeFile(file, SECRET, { mode: 0o600 });
  const fixture = await serveFixture("password.html");
  try {
    await withClient(
      async (client) => {
        const result = await client.callTool(
          {
            name: "jev_navigate",
            arguments: {
              task: "Fill the password field with the configured password, then stop",
              start_url: `${fixture.origin}/`,
              max_steps: 4,
              max_seconds: 60,
              password_file: file,
            },
          },
          undefined,
          { timeout: 120_000 },
        );
        const body = payload(result);
        const refused = body.steps.find((s) => /origin_mismatch/.test(s.action_error ?? ""));
        assert.ok(refused, `expected an origin_mismatch refusal: ${JSON.stringify(body.steps.map((s) => s.action_error))}`);
        assert.notEqual(body.password_filled, true);
        assert.equal(body.screenshot_suppressed, "credential-fill"); // even a refused fill attempt suppresses it
        assert.ok(!body.page.content.includes("PW_FILLED"), "nothing may be filled on the wrong origin");
        assert.ok(!body.page.content.includes("SUBMITTED"));
        assert.ok(!result.content.some((b) => b.type === "image"), "no screenshot image block may travel on a credential run");
        assertNoSecret(result, body);
      },
      // Trust anchor points elsewhere: every fill on the fixture origin is refused.
      { JEV_BROWSER_PASSWORD_ORIGIN: "http://127.0.0.1:9", JEV_BROWSER_HANDOFF_DIR: dir },
    );
  } finally {
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("password fill: JEV_PASSWORD_* env path works; other names are rejected", { skip: !hasKey }, async () => {
  const fixture = await serveFixture("password.html");
  try {
    await withClient(
      async (client) => {
        const result = await client.callTool(
          {
            name: "jev_navigate",
            arguments: {
              task: "Fill the password field with the configured password, then stop",
              start_url: `${fixture.origin}/`,
              max_steps: 5,
              max_seconds: 60,
              password_env: "JEV_PASSWORD_E2E",
            },
          },
          undefined,
          { timeout: 120_000 },
        );
        const body = payload(result);
        assert.ok(body.steps.some((s) => /^fill_password_/.test(s.executed_action ?? "") && !s.action_error), "fill did not execute");
        assert.ok(body.page.content.includes("PW_FILLED"));
        assertNoSecret(result, body);

        // A non-prefixed name is rejected before its value is ever read.
        const rejected = await client.callTool(
          {
            name: "jev_navigate",
            arguments: { task: "x", start_url: `${fixture.origin}/`, password_env: "TYPESAFE_API_KEY" },
          },
          undefined,
          { timeout: 30_000 },
        );
        assert.equal(rejected.isError, true);
        assert.match(rejected.content.find((b) => b.type === "text").text, /JEV_PASSWORD_/);
      },
      { JEV_BROWSER_PASSWORD_ORIGIN: fixture.origin, JEV_PASSWORD_E2E: SECRET },
    );
  } finally {
    await fixture.close();
  }
});

test("password fill: CLI stdin path works and never leaks the secret", { skip: !hasKey }, async () => {
  const fixture = await serveFixture("password.html");
  try {
    const child = spawn(
      process.execPath,
      [
        serverPath, "run",
        "Fill the password field with the configured password, then stop",
        `${fixture.origin}/`,
        "--password-file", "-",
        "--password-origin", fixture.origin,
        "--no-screenshot",
        "--max-steps", "5",
        "--max-seconds", "60",
      ],
      { env: { ...process.env } },
    );
    child.stdin.write(SECRET);
    child.stdin.end();
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stdout);
    const body = JSON.parse(stdout);
    assert.ok(body.steps.some((s) => /^fill_password_/.test(s.executed_action ?? "") && !s.action_error), "fill did not execute");
    assert.ok(body.page.content.includes("PW_FILLED"));
    assert.ok(!stdout.includes(SECRET) && !stdout.includes(encodeURIComponent(SECRET)), "the secret leaked into CLI output");
  } finally {
    await fixture.close();
  }
});

test("password fill: PWDEBUG is refused before any browser or Jev work", async () => {
  // The preflight runs inside the CLI's credential-setup block, before
  // stdin is read or any browser/Jev client exists: the run must fail fast
  // with the debug refusal, with no API key needed.
  const child = spawn(
    process.execPath,
    [
      serverPath, "run",
      "x", "https://example.com/",
      "--password-file", "-",
      "--password-origin", "https://acme.com",
    ],
    { env: { ...process.env, PWDEBUG: "1", TYPESAFE_API_KEY: "" } },
  );
  child.stdin.end();
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /password source: .*PWDEBUG/);
});

test("password fill: misconfigured handoff files fail loudly, before any browser", async () => {
  const dir = await mkdtemp(join(tmpdir(), "jev-handoff-e2e-"));
  await chmod(dir, 0o700);
  const loose = join(dir, "loose");
  await writeFile(loose, SECRET, { mode: 0o644 });
  try {
    await withClient(
      async (client) => {
        const cases = [
          [{ task: "x", start_url: "https://example.com/", password_file: loose }, /0600/],
          [{ task: "x", start_url: "https://example.com/", password_file: "/etc/passwd" }, /inside the handoff directory/],
          [{ task: "x", start_url: "https://example.com/", password_file: loose, password_env: "JEV_PASSWORD_E2E" }, /at most one/],
        ];
        for (const [args, pattern] of cases) {
          const rejected = await client.callTool({ name: "jev_navigate", arguments: args }, undefined, { timeout: 30_000 });
          assert.equal(rejected.isError, true, JSON.stringify(args));
          assert.match(rejected.content.find((b) => b.type === "text").text, pattern);
        }
      },
      { JEV_BROWSER_PASSWORD_ORIGIN: "https://example.com", JEV_BROWSER_HANDOFF_DIR: dir, JEV_PASSWORD_E2E: SECRET },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multi-field form: typing fields does not submit the form", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  const typing = await startFakeTypingAPI("Ada");
  try {
    await withClient(
      async (client) => {
      const result = await client.callTool(
        {
          name: "jev_navigate",
          arguments: {
            task: "Enter Ada as the First name and Oslo as the City on the club signup form, then stop. Do not submit the form.",
            start_url: `${site.baseUrl}/join`,
            max_steps: 6,
            max_seconds: 90,
          },
        },
        undefined,
        { timeout: 180_000 },
      );
      const body = payload(result);
      const typed = body.steps.filter((s) => s.executed_action?.startsWith("type_") && !s.action_error);
      assert.ok(typed.length >= 1, `expected typed steps: ${JSON.stringify(body.steps)}`);
      for (const step of typed) {
        assert.ok(
          !/^navigated/.test(step.outcome ?? ""),
          `typing a field submitted the form at step ${step.step} (${step.outcome})`,
        );
      }
      assert.ok(
        !site.requests.some((r) => r.includes("/joined")),
        `the form was submitted anyway; requests: ${site.requests.join(", ")}`,
      );
      assert.equal(body.degraded, false);
      },
      { JEV_BROWSER_TYPE_BASE_URL: `${typing.baseUrl}/v1` },
    );
  } finally {
    typing.close();
    site.close();
  }
});

test("search flow: type then submit reaches the results page", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  const typing = await startFakeTypingAPI("ristretto");
  try {
    await withClient(
      async (client) => {
      const result = await client.callTool(
        {
          name: "jev_navigate",
          arguments: {
            task: 'Search this site for "ristretto" and stop on the results page',
            start_url: `${site.baseUrl}/find`,
            max_steps: 5,
            max_seconds: 90,
          },
        },
        undefined,
        { timeout: 180_000 },
      );
      const body = payload(result);
      assert.ok(
        ["done", "goal_achieved"].includes(body.status),
        `status was ${body.status}: ${JSON.stringify(body.steps)}`,
      );
      assert.match(body.final_url, /\/found\?/);
      assert.ok(site.requests.some((r) => r.startsWith("GET /found")), `results never requested: ${site.requests.join(", ")}`);
      // The fixture has no submit button, so reaching /found requires the
      // explicit two-step flow: type (fill only, stays on the page) then
      // submit_eN, which presses Enter on the field.
      const typeStep = body.steps.find((s) => s.executed_action?.startsWith("type_"));
      const submitStep = body.steps.find((s) => s.executed_action?.startsWith("submit_"));
      assert.ok(typeStep, `no typed step: ${JSON.stringify(body.steps)}`);
      assert.ok(submitStep, `no explicit submit step: ${JSON.stringify(body.steps)}`);
      assert.ok(typeStep.step < submitStep.step, "submit must follow the typed step");
      assert.ok(!/^navigated/.test(typeStep.outcome ?? ""), "typing alone must not submit the search");
      assert.match(submitStep.detail ?? "", /Enter/, `unexpected submit detail: ${submitStep.detail}`);
      assert.equal(body.degraded, false);
      },
      { JEV_BROWSER_TYPE_BASE_URL: `${typing.baseUrl}/v1` },
    );
  } finally {
    typing.close();
    site.close();
  }
});

test("form submission: the submit button is a submit_eN action", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    await withClient(async (client) => {
      const result = await client.callTool(
        {
          name: "jev_navigate",
          arguments: {
            task: "Submit the club signup form and stop on the confirmation page",
            start_url: `${site.baseUrl}/join`,
            max_steps: 5,
            max_seconds: 90,
          },
        },
        undefined,
        { timeout: 180_000 },
      );
      const body = payload(result);
      assert.ok(
        ["done", "goal_achieved"].includes(body.status),
        `status was ${body.status}: ${JSON.stringify(body.steps)}`,
      );
      assert.match(body.final_url, /\/joined/);
      // The button (no type attribute, inside the form) must be offered and
      // executed as submit_eN, not click_eN.
      const submitStep = body.steps.find((s) => s.executed_action?.startsWith("submit_"));
      assert.ok(submitStep, `no submit step: ${JSON.stringify(body.steps)}`);
      assert.match(submitStep.detail ?? "", /button "Join"/, `unexpected submit detail: ${submitStep.detail}`);
      assert.ok(
        !body.steps.some((s) => s.executed_action?.startsWith("click_")),
        "the submit control must not be stamped click_",
      );
    });
  } finally {
    site.close();
  }
});

// Regression: input[type=submit] carries its label in the value attribute, so
// it must appear in the action space labeled "Pay now" (not as unlabeled noise)
// and execute as submit_eN, never click_eN.
test("input submit control: the value attribute labels it", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    await withClient(async (client) => {
      const result = await client.callTool(
        {
          name: "jev_navigate",
          arguments: {
            task: "Submit the payment form and stop on the confirmation page",
            start_url: `${site.baseUrl}/pay`,
            max_steps: 5,
            max_seconds: 90,
          },
        },
        undefined,
        { timeout: 180_000 },
      );
      const body = payload(result);
      assert.ok(
        ["done", "goal_achieved"].includes(body.status),
        `status was ${body.status}: ${JSON.stringify(body.steps)}`,
      );
      assert.match(body.final_url, /\/paid/);
      const submitStep = body.steps.find((s) => s.executed_action?.startsWith("submit_"));
      assert.ok(submitStep, `no submit step: ${JSON.stringify(body.steps)}`);
      assert.match(submitStep.detail ?? "", /"Pay now"/, `unexpected submit detail: ${submitStep.detail}`);
      assert.ok(
        !body.steps.some((s) => s.executed_action?.startsWith("click_")),
        "the submit control must not be stamped click_",
      );
    });
  } finally {
    site.close();
  }
});

// Regression: input[type=submit] with no value attribute would extract as an
// empty label and drop out of the action space entirely, making the form
// unsubmittable. The browser-default label "Submit" must keep it stamped.
test("input submit without a value keeps the default Submit label", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    await withClient(async (client) => {
      const result = await client.callTool(
        {
          name: "jev_navigate",
          arguments: {
            task: "Submit the RSVP form and stop on the confirmation page",
            start_url: `${site.baseUrl}/rsvp`,
            max_steps: 5,
            max_seconds: 90,
          },
        },
        undefined,
        { timeout: 180_000 },
      );
      const body = payload(result);
      assert.ok(
        ["done", "goal_achieved"].includes(body.status),
        `status was ${body.status}: ${JSON.stringify(body.steps)}`,
      );
      assert.match(body.final_url, /\/rsvped/);
      const submitStep = body.steps.find((s) => s.executed_action?.startsWith("submit_"));
      assert.ok(submitStep, `no submit step: ${JSON.stringify(body.steps)}`);
      assert.match(submitStep.detail ?? "", /"Submit"/, `unexpected submit detail: ${submitStep.detail}`);
    });
  } finally {
    site.close();
  }
});

test("password fill: injected page works under the same guards and never closes the caller's browser", { skip: !hasKey }, async () => {
  const fixture = await serveFixture("password.html");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/`, { waitUntil: "domcontentloaded" });

    const body = await navigate({
      task: "Fill the password field with the configured password, then stop",
      page,
      maxSteps: 5,
      maxSeconds: 60,
      password: { value: SECRET, origin: fixture.origin },
    });

    const fill = body.steps.find((s) => /^fill_password_/.test(s.executed_action ?? "") && !s.action_error);
    assert.ok(fill, `no fill executed: ${JSON.stringify(body.steps.map((s) => [s.proposed_action, s.executed_action, s.action_error]))}`);
    assert.match(fill.detail ?? "", /filled password into "Password"; not submitted/);
    assert.equal(body.password_filled, true);
    assert.equal(body.screenshot_suppressed, "credential-fill");
    assert.equal(body.screenshot_base64_jpeg, null, "screenshot bytes must be suppressed after a fill");
    assert.ok(body.page.content.includes("PW_FILLED"), "the page should show the fill marker");
    assert.ok(!body.page.content.includes("SUBMITTED"), "the form must never be submitted by a fill");
    assert.ok(body.page.content.includes("mirror: [REDACTED]"), "a reflected echo must be redacted in the payload");
    const echo = (body.console_events ?? []).find((e) => e.type === "console_error");
    assert.ok(echo, "the fixture's console.error echo should be captured");
    assert.match(echo.text, /echo: \[REDACTED\]/);
    const haystack = JSON.stringify(body);
    for (const variant of [SECRET, encodeURIComponent(SECRET), SECRET.replace(/([&<>"'])/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c)]) {
      assert.ok(!haystack.includes(variant), "the secret (or an encoded echo) leaked into the library result");
    }
    assert.equal(page.isClosed(), false, "the caller's page must stay open");
    assert.ok(browser.isConnected(), "the caller's browser must stay open");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

// ── Issue #2: typing degradation is visible and ordinary fields never get soup ──

// The dead typing provider: a strict JEV_BROWSER_TYPE_PROVIDER=openrouter
// selection whose endpoint points at a closed port. The run must complete
// (no isError), the type_eN step must record an action error and type
// nothing, and the result must carry the structured degradation records.
const DEAD_TYPING_ENV = {
  JEV_BROWSER_TYPE_PROVIDER: "openrouter",
  OPENROUTER_API_KEY: "sk-or-v1-0000000000000000000000000000",
  JEV_BROWSER_TYPE_BASE_URL: "http://127.0.0.1:1",
};

test("degraded type_eN: a dead typing provider types nothing and reports structured warnings (#2)", async () => {
  const { createServer } = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const fixture = readFileSync(fileURLToPath(new URL("./fixtures/login.html", import.meta.url)));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await withClient(
      async (client) => {
        const result = await client.callTool(
          {
            name: "jev_navigate",
            arguments: {
              task: "Type the word tomsmith into the username input field and stop",
              start_url: `http://127.0.0.1:${port}/`,
              max_steps: 4,
              max_seconds: 60,
            },
          },
          undefined,
          { timeout: 120_000 },
        );
        const body = payload(result);
        // Degradation is not an error: the run completed, only typing did not.
        assert.notEqual(result.isError, true);
        const failedType = body.steps.find((s) => s.action_error === "typing generator failed; nothing was typed");
        assert.ok(failedType, `expected a failed type step: ${JSON.stringify(body.steps)}`);
        assert.ok(!body.steps.some((s) => /^typed "/.test(s.detail ?? "")), "nothing may be typed when the generator fails");
        assert.equal(body.degraded, true);
        const warning = body.warnings.find((w) => w.code === "typing_generator_error");
        assert.ok(warning, `expected a typing_generator_error warning: ${JSON.stringify(body.warnings)}`);
        assert.equal(warning.step, failedType.step);
        assert.equal(warning.provider, "openrouter");
        assert.equal(warning.model, "google/gemini-2.5-flash-lite");
        assert.ok(warning.message.length <= 200, `warning message must stay short: ${warning.message}`);
        // Port 1 is on fetch's blocked-port list, so the SDK words the failure
        // "bad port" instead of ECONNREFUSED; either way the dead endpoint
        // shows up in the short summary, and never a raw response body.
        assert.match(warning.message, /Cannot connect to API|ECONNREFUSED/);
        assert.ok(!("fallback" in warning), "ordinary fields get no heuristic fallback");
        assert.ok(!("finish_reason" in warning));
        assert.equal(body.typing_provider, "openrouter");
        assert.equal(body.typing_model, "google/gemini-2.5-flash-lite");
      },
      DEAD_TYPING_ENV,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("degraded search_eN: a dead typing provider still searches via the keyword heuristic (#2)", async () => {
  const site = await startFixtureSite();
  try {
    await withClient(
      async (client) => {
        const result = await client.callTool(
          {
            name: "jev_navigate",
            arguments: {
              task: 'Search this site for "ristretto" and stop on the results page',
              start_url: `${site.baseUrl}/lookup`,
              max_steps: 4,
              max_seconds: 90,
            },
          },
          undefined,
          { timeout: 180_000 },
        );
        const body = payload(result);
        assert.notEqual(result.isError, true);
        assert.ok(
          ["done", "goal_achieved"].includes(body.status),
          `status was ${body.status}: ${JSON.stringify(body.steps)}`,
        );
        assert.match(body.final_url, /\/found\?q=/);
        assert.ok(site.requests.some((r) => r.startsWith("GET /found")), `results never requested: ${site.requests.join(", ")}`);
        // The search-tuned heuristic ran after the generator failed, and the
        // step detail says so explicitly.
        const searched = body.steps.find((s) => /^search_/.test(s.executed_action ?? "") && !s.action_error);
        assert.ok(searched, `expected a search step: ${JSON.stringify(body.steps)}`);
        assert.equal(searched.detail, 'searched "ristretto results" via keyword-heuristic-after-generator-error');
        assert.equal(body.degraded, true);
        const warning = body.warnings.find((w) => w.code === "typing_generator_error");
        assert.ok(warning, `expected a typing_generator_error warning: ${JSON.stringify(body.warnings)}`);
        assert.equal(warning.fallback, "keyword-heuristic");
        assert.equal(warning.step, searched.step);
        assert.equal(body.typing_provider, "openrouter");
      },
      DEAD_TYPING_ENV,
    );
  } finally {
    site.close();
  }
});

test("JEV_BROWSER_TYPE_PROVIDER is strict: unknown provider or missing key refuses to start (#2)", async () => {
  await withClient(
    async (client) => {
      const args = {
        name: "jev_navigate",
        arguments: { task: "x", start_url: "https://example.com/", max_steps: 1, max_seconds: 10 },
      };
      // An unknown value names no provider at all, on every call: no key
      // in the environment can rescue it and no other provider is tried.
      const unknown = await client.callTool(args, undefined, { timeout: 30_000 });
      assert.equal(unknown.isError, true);
      assert.match(unknown.content.find((b) => b.type === "text").text, /JEV_BROWSER_TYPE_PROVIDER "bogus" is not a known typing provider/);
      const unknownAgain = await client.callTool(args, undefined, { timeout: 30_000 });
      assert.equal(unknownAgain.isError, true);
    },
    { JEV_BROWSER_TYPE_PROVIDER: "bogus" },
  );
  await withClient(
    async (client) => {
      const rejected = await client.callTool(
        {
          name: "jev_navigate",
          arguments: { task: "x", start_url: "https://example.com/", max_steps: 1, max_seconds: 10 },
        },
        undefined,
        { timeout: 30_000 },
      );
      assert.equal(rejected.isError, true);
      assert.match(rejected.content.find((b) => b.type === "text").text, /ANTHROPIC_API_KEY/);
    },
    { JEV_BROWSER_TYPE_PROVIDER: "anthropic" },
  );
});

test("CLI: a strict typing-config failure exits nonzero with one stderr line (#2)", async () => {
  const child = spawn(process.execPath, [serverPath, "run", "x", "https://example.com/"], {
    env: { ...process.env, JEV_BROWSER_TYPE_PROVIDER: "bogus", TYPESAFE_API_KEY: "" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => child.on("close", (exitCode) => resolve(exitCode)));
  assert.notEqual(code, 0, `expected a nonzero exit, stderr: ${stderr}`);
  assert.match(stderr, /navigate: .*JEV_BROWSER_TYPE_PROVIDER/);
});

test("allow_typing false ignores typing configuration entirely (#2)", async () => {
  const { createServer } = await import("node:http");
  const { readFileSync } = await import("node:fs");
  const fixture = readFileSync(fileURLToPath(new URL("./fixtures/login.html", import.meta.url)));
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(fixture);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await withClient(
      async (client) => {
        const result = await client.callTool(
          {
            name: "jev_navigate",
            arguments: {
              task: "The task is already complete; stop immediately without doing anything",
              start_url: `http://127.0.0.1:${port}/`,
              max_steps: 2,
              max_seconds: 30,
              allow_typing: false,
            },
          },
          undefined,
          { timeout: 90_000 },
        );
        const body = payload(result);
        assert.notEqual(result.isError, true);
        assert.ok(["done", "goal_achieved", "stuck"].includes(body.status), `status was ${body.status}`);
        // Typing is off, so a broken typing config is none of this run's
        // business: no degradation, and no typing configuration reported.
        assert.equal(body.degraded, false);
        assert.deepEqual(body.warnings, []);
        assert.equal(body.typing_provider, null);
        assert.equal(body.typing_model, null);
      },
      { JEV_BROWSER_TYPE_PROVIDER: "bogus" },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── Bot protection: Cloudflare interstitials are named, not reasoned about ──

test("bot protection: a persistent challenge stops the run before any Jev call", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    const body = await navigate({
      task: "Report the page title and stop",
      startUrl: `${site.baseUrl}/locked`,
      maxSteps: 4,
      maxSeconds: 60,
    });
    assert.equal(body.status, "blocked");
    assert.ok(body.bot_protection, "bot_protection must be present on a blocked run");
    assert.equal(body.bot_protection.provider, "cloudflare");
    assert.equal(body.bot_protection.kind, "challenge");
    assert.ok(body.bot_protection.evidence.some((e) => e.startsWith("title ")));
    assert.ok(body.bot_protection.guidance.length > 0);
    assert.equal(body.usage.jev_calls, 0, "no Jev call may be spent on an interstitial");
    assert.equal(body.steps.length, 0, "no steps may be recorded on an interstitial");
    assert.match(body.final_title, /Just a moment/);
  } finally {
    site.close();
  }
});

test("bot protection: a hard block stops the run immediately with kind block", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    const started = Date.now();
    const body = await navigate({
      task: "Report the page title and stop",
      startUrl: `${site.baseUrl}/hardblock`,
      maxSteps: 4,
      maxSeconds: 60,
    });
    assert.equal(body.status, "blocked");
    assert.equal(body.bot_protection.kind, "block");
    assert.ok(body.bot_protection.guidance.includes("different network"));
    assert.equal(body.usage.jev_calls, 0);
    assert.equal(body.steps.length, 0);
    assert.ok(Date.now() - started < 10_000, "a hard block gets no challenge wait-out window");
  } finally {
    site.close();
  }
});

test("bot protection: a challenge that clears itself within its window lets the run proceed", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    const body = await navigate({
      task: "Report the page title and stop",
      startUrl: `${site.baseUrl}/clearing`,
      maxSteps: 4,
      maxSeconds: 60,
    });
    assert.ok(body.status === "done" || body.status === "goal_achieved", `run should complete, got ${body.status}`);
    assert.equal(body.bot_protection, undefined, "a cleared challenge must not leave bot_protection set");
    assert.equal(body.final_title, "Welcome in");
    assert.ok(body.usage.jev_calls >= 1, "the run must proceed to real Jev steps after the challenge clears");
  } finally {
    site.close();
  }
});

test("bot protection: the cf-mitigated header alone never stops a run, only annotates it", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    const body = await navigate({
      task: "Report the page title and stop",
      startUrl: `${site.baseUrl}/mitigated`,
      maxSteps: 4,
      maxSeconds: 60,
    });
    assert.ok(body.status === "done" || body.status === "goal_achieved", `run should complete, got ${body.status}`);
    assert.ok(body.bot_protection, "the header signal should be annotated");
    assert.deepEqual(body.bot_protection.evidence, ["header cf-mitigated: challenge"]);
    assert.equal(body.final_title, "Coffee menu");
    assert.ok(body.usage.jev_calls >= 1);
  } finally {
    site.close();
  }
});

test("bot protection: a wall that appears on the final page flips the status instead of reporting done", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    const body = await navigate({
      task: "Click the Continue link",
      startUrl: `${site.baseUrl}/locklate`,
      maxSteps: 1,
      maxSeconds: 60,
    });
    // One judgment was spent on the real page, then the click landed on the
    // challenge as the budget ended: the run must not report max_steps (or
    // done) over an interstitial.
    assert.equal(body.status, "blocked", `expected blocked, got ${body.status}: ${JSON.stringify(body.steps)}`);
    assert.equal(body.bot_protection.kind, "challenge");
    assert.equal(body.steps.length, 1);
    assert.equal(body.usage.jev_calls, 1);
    assert.match(body.steps[0].executed_action ?? "", /^click_/);
    assert.match(body.final_title, /Just a moment/);
  } finally {
    site.close();
  }
});

test("bot protection: a final-page challenge that clears in its window reports the real page", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    const body = await navigate({
      task: "Click the Continue link",
      startUrl: `${site.baseUrl}/lockclearing`,
      maxSteps: 1,
      maxSeconds: 60,
    });
    // The challenge was on the final page when the budget ended, but it
    // auto-passed during the settle window: the outcome must NOT flip to
    // blocked, no wall may be annotated from the stale pre-settle page, and
    // the reported final page must be the real content that painted after it.
    assert.equal(body.status, "max_steps", `expected max_steps, got ${body.status}`);
    assert.equal(body.bot_protection, undefined, "a cleared final-page challenge must not leave bot_protection set");
    assert.equal(body.final_title, "Welcome in");
    assert.equal(body.steps.length, 1);
    assert.equal(body.usage.jev_calls, 1);
    assert.match(body.steps[0].executed_action ?? "", /^click_/);
  } finally {
    site.close();
  }
});

test("bot protection: a challenge the budget cannot verify keeps the timeout outcome", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    const body = await navigate({
      task: "Report the page title and stop",
      startUrl: `${site.baseUrl}/locked`,
      maxSteps: 2,
      maxSeconds: 1,
    });
    // The wall is on the page, but the run has no budget left for the settle
    // window that would verify the challenge persists (it may auto-pass), so
    // the deadline outcome keeps precedence: timeout, with the wall annotated
    // as evidence rather than claimed as the outcome.
    assert.equal(body.status, "timeout", `expected timeout, got ${body.status}`);
    assert.ok(body.bot_protection, "the unverified wall must still be annotated");
    assert.equal(body.bot_protection.kind, "challenge");
    assert.equal(body.usage.jev_calls, 0);
    assert.equal(body.steps.length, 0);
  } finally {
    site.close();
  }
});
