// End-to-end: spawn the built server over stdio and run real navigation tasks.
// Skipped unless TYPESAFE_API_KEY is set. Requires Playwright Chromium.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const hasKey = Boolean(process.env.TYPESAFE_API_KEY);

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
    // a bot-challenge page (50x-tq.html); when it does, clean termination is
    // the most this test can demand.
    const typedOk = body.steps.some((s) => /typed "/.test(s.detail ?? "") && !s.action_error);
    const challenged = /50x|anomaly|challenge/i.test(body.final_url ?? "") || /50x/.test(body.final_title ?? "");
    assert.ok(typedOk || challenged, "expected successful typing or a DuckDuckGo challenge page");
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
  try {
    await withClient(async (client) => {
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
      assert.ok(["done", "goal_achieved"].includes(body.status), `status was ${body.status}`);
    });
  } finally {
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

const SECRET = "e2e pw!&q=1";

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
        assert.ok(!body.page.content.includes("PW_FILLED"), "nothing may be filled on the wrong origin");
        assert.ok(!body.page.content.includes("SUBMITTED"));
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
