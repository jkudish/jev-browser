import { request, createServer } from "node:http";
import { connect } from "node:net";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const serverPath = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const TOKEN = "test-token-0123456789abcdef";

async function startHttp(env) {
  const child = spawn(process.execPath, [serverPath, "--http"], {
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "test-key", HOST: "127.0.0.1", PORT: "0", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  const url = await new Promise((resolve, reject) => {
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/stateless HTTP at (\S+)/);
      if (match) resolve(new URL(match[1]));
    });
    child.once("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
  });
  return { url, stop: async () => { child.kill("SIGTERM"); await once(child, "exit"); } };
}

async function listTools(url, versionNegotiation) {
  const client = new Client({ name: "http-test", version: "1.0.0" }, versionNegotiation ? { versionNegotiation } : {});
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
  );
  try {
    return { era: client.getProtocolEra(), names: (await client.listTools()).tools.map((t) => t.name) };
  } finally {
    await client.close();
  }
}

test("--http refuses a non-loopback bind without DISCERN_BROWSER_AUTH_TOKEN", async () => {
  const child = spawn(process.execPath, [serverPath, "--http"], {
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "test-key", HOST: "0.0.0.0", PORT: "0" },
    stdio: "ignore",
  });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
});

test("--http serves 2025-era and 2026-07-28 clients statelessly behind a bearer token", async () => {
  const { url, stop } = await startHttp({ DISCERN_BROWSER_AUTH_TOKEN: TOKEN });
  try {
    assert.equal((await fetch(new URL("/health", url))).status, 200);
    const denied = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(denied.status, 401);

    const legacy = await listTools(url);
    assert.equal(legacy.era, "legacy");
    assert.deepEqual(legacy.names, ["discern_navigate"]);

    const modern = await listTools(url, { mode: { pin: "2026-07-28" } });
    assert.equal(modern.era, "modern");
    assert.deepEqual(modern.names, legacy.names);
  } finally {
    await stop();
  }
});

test("--http on loopback without a token rejects a foreign Host or Origin (DNS rebinding)", async () => {
  const { url, stop } = await startHttp({ HOST: "127.0.0.1", PORT: "0" });
  // node:http, not fetch: fetch silently drops a caller-set Host header.
  const post = (extra) =>
    new Promise((resolve, reject) => {
      const req = request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...extra,
        },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
  try {
    for (const extra of [{ host: "evil.example" }, { origin: "https://evil.example" }]) {
      const { status, body } = await post(extra);
      assert.equal(status, 403);
      assert.ok(!body.includes("evil.example"), `reflected rejection value in body: ${body}`);
      assert.equal(JSON.parse(body).error.message, "Forbidden");
    }
  } finally {
    await stop();
  }
});

test("--http defaults to a loopback bind when HOST is unset", async () => {
  const child = spawn(process.execPath, [serverPath, "--http"], {
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "test-key", PORT: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  try {
    const url = await new Promise((resolve, reject) => {
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
        const match = stderr.match(/stateless HTTP at (\S+)/);
        if (match) resolve(new URL(match[1]));
      });
      child.once("exit", (code) => reject(new Error(`server exited ${code}: ${stderr}`)));
    });
    assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname), `non-loopback default bind: ${url.hostname}`);
  } finally {
    child.kill("SIGTERM");
  }
});

test("--http advertises a static tool list and refuses subscriptions/listen without holding a slot", async () => {
  const { url, stop } = await startHttp({ DISCERN_BROWSER_MAX_CONCURRENCY: "1", DISCERN_BROWSER_AUTH_TOKEN: TOKEN });
  try {
    const client = new Client(
      { name: "listen-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }),
    );
    try {
      // A static tool list advertises no listChanged, so capable clients have
      // no reason to open a listener; an explicit one is refused in-band...
      assert.equal(client.getServerCapabilities()?.tools?.listChanged, false);
      await assert.rejects(
        client.listen({ notifications: { tools: true } }),
        (error) => /subscription|limit|not/i.test(String(error?.message ?? error)),
      );
      // ...and the refused listener must not occupy the single concurrency slot.
      assert.equal((await client.listTools()).tools.length, 1);
    } finally {
      await client.close();
    }
  } finally {
    await stop();
  }
});

test("--http releases the slot when a client disconnects mid tools/call", async () => {
  // A TCP server that accepts connections and never responds keeps the
  // navigation in flight long enough to disconnect from it.
  const stall = createServer(() => {});
  await new Promise((resolve) => stall.listen(0, "127.0.0.1", resolve));
  const stallUrl = `http://127.0.0.1:${stall.address().port}/`;
  const { url, stop } = await startHttp({ DISCERN_BROWSER_MAX_CONCURRENCY: "1", DISCERN_BROWSER_AUTH_TOKEN: TOKEN });
  const post = (id, body) =>
    new Promise((resolve, reject) => {
      const req = request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${TOKEN}`,
        },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
    });
  const eventuallyServed = async () => {
    for (let i = 0; i < 40; i++) {
      if ((await post(2, { method: "tools/list" })) === 200) return 200;
      await new Promise((r) => setTimeout(r, 250));
    }
    return await post(2, { method: "tools/list" });
  };
  try {
    const call = request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${TOKEN}`,
      },
    }, (res) => { res.resume(); });
    call.on("error", () => {});
    call.end(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "discern_navigate", arguments: { task: "Open the page", start_url: stallUrl, max_steps: 2, max_seconds: 60, screenshot: "none" } },
    }));
    await new Promise((r) => setTimeout(r, 1500));
    // Disconnect the caller mid-navigation: the abort must tear the run down
    // and free the single slot instead of 429-ing the server until deadline.
    call.destroy();
    assert.equal(await eventuallyServed(), 200);
  } finally {
    stall.close();
    await stop();
  }
});

test("--http sheds load with 429 past DISCERN_BROWSER_MAX_CONCURRENCY", async () => {
  const { url, stop } = await startHttp({ DISCERN_BROWSER_MAX_CONCURRENCY: "1", DISCERN_BROWSER_AUTH_TOKEN: TOKEN });
  // Hold the one permitted slot open mid-body: raw socket, headers sent, body withheld.
  const held = connect({ host: url.hostname, port: Number(url.port) });
  await once(held, "connect");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  held.write(
    `POST ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${TOKEN}\r\n` +
    `Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  const post = (headers) =>
    new Promise((resolve, reject) => {
      const req = request(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...headers,
        },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject);
      req.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    });
  const authed = () => post({ authorization: `Bearer ${TOKEN}` });
  // Bounded retry: the slot frees when the held response is written, which can
  // land just after the first probe observes the headers.
  const authedEventually = async () => {
    for (let i = 0; i < 20; i++) {
      if ((await authed()) === 200) return 200;
      await new Promise((r) => setTimeout(r, 50));
    }
    return await authed();
  };
  try {
    // Auth is checked before the cap: a bad credential gets 401 even when full.
    assert.equal(await post({ authorization: "Bearer wrong-token" }), 401);
    assert.equal(await post({}), 401);
    assert.equal(await authed(), 429);
    // Release the slot: finish the held body, wait for the response bytes (the
    // SSE response keeps the socket open, so "close" would never fire), then
    // drop the socket — freeing the slot happens when the response is written.
    held.on("error", () => {});
    held.end(body);
    await once(held, "data");
    held.destroy();
    assert.equal(await authedEventually(), 200);
  } finally {
    held.destroy();
    await stop();
  }
});
