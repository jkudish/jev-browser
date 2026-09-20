// End-to-end: spawn the built server over stdio and run real navigation tasks.
// Skipped unless TYPESAFE_API_KEY is set. Requires Playwright Chromium.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const hasKey = Boolean(process.env.TYPESAFE_API_KEY);

async function withClient(fn) {
  const client = new Client({ name: "jev-browser-e2e", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: {
      TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY ?? "",
      ...(process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {}),
      ...(process.env.JEV_BROWSER_TYPE_MODEL ? { JEV_BROWSER_TYPE_MODEL: process.env.JEV_BROWSER_TYPE_MODEL } : {}),
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
