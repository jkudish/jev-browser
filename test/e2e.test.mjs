// End-to-end: spawn the built server over stdio and run real navigation tasks.
// Skipped unless TYPESAFE_API_KEY is set. Requires Playwright Chromium.
// Local fixtures (form/search pages served by node:http) back the submit tests;
// the rest drive real sites.
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const hasKey = Boolean(process.env.TYPESAFE_API_KEY);

// Minimal deterministic site: a multi-field form with a submit button (the
// button carries no type attribute, so it defaults to submit inside the form),
// and a search box with no submit button at all. The search box is a plain
// text input on purpose: only input[type=search]/role=searchbox get the
// one-action search_eN, so this one must stay reachable the explicit way,
// type then submit_eN pressing Enter.
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
    } else if (url.pathname === "/find") {
      res.end(
        page(
          "Find a drink",
          `<form action="/found" method="get">
             <input name="q" type="text" aria-label="Search" placeholder="Search for a drink">
           </form>`,
        ),
      );
    } else if (url.pathname === "/found") {
      res.end(page("Results", `<p>Ristretto: a short shot of espresso (${url.searchParams.get("q") ?? ""})</p>`));
    } else {
      res.statusCode = 404;
      res.end(page("Not found", ""));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { requests, baseUrl: `http://127.0.0.1:${address.port}`, close: () => server.close() };
}

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
    // Wikipedia's search input is input[type=search], so the search is one
    // explicit search_eN action: fill and Enter together.
    const searchStep = body.steps.find((s) => s.executed_action?.startsWith("search_"));
    assert.ok(searchStep, `no search_ step: ${JSON.stringify(body.steps)}`);
    assert.match(searchStep.detail ?? "", /^searched "/, `unexpected search detail: ${searchStep.detail}`);
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

test("multi-field form: typing fields does not submit the form", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    await withClient(async (client) => {
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
    });
  } finally {
    site.close();
  }
});

test("search flow: type then submit reaches the results page", { skip: !hasKey }, async () => {
  const site = await startFixtureSite();
  try {
    await withClient(async (client) => {
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
    });
  } finally {
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
