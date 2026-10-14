// discern-browser 1.x compatibility over real MCP clients and real processes:
// tool-name listing and aliases, JEV_ environment aliases, conflict errors,
// the Chromium postinstall opt-out, and the @jkudish/jev-browser compat bin.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = fileURLToPath(new URL("..", import.meta.url));
const serverPath = join(root, "dist", "index.js");
const SECRET = "hunter2-never-print-this";
const OTHER_SECRET = "correct-horse-never-print";
// Arguments that reach the tool handler and fail on configuration before any
// browser launch or network call, so a call proves routing without side effects.
const PASSWORD_ARGS = { task: "Log in", start_url: "https://acme.example/login", password_env: "JEV_PASSWORD_MISSING" };

async function connect(entry, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TYPESAFE_API_KEY: "test-key", ...env },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    stderr: () => stderr,
    names: async () => (await client.listTools()).tools.map((tool) => tool.name),
    call: (name, args = PASSWORD_ARGS) => client.callTool({ name, arguments: args }),
    close: () => client.close(),
  };
}

async function run(args, env = {}, entry = serverPath) {
  const child = spawn(process.execPath, [entry, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TYPESAFE_API_KEY: "test-key", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const [code] = await once(child, "exit");
  return { code, stdout, stderr };
}

const deprecations = (stderr, name) => stderr.split("\n").filter((line) => line.includes(`${name} is deprecated`)).length;

test("lists discern_navigate by default; jev_navigate stays callable as a hidden alias", async () => {
  const server = await connect(serverPath);
  try {
    assert.equal(server.client.getServerVersion()?.name, "discern-browser");
    assert.deepEqual(await server.names(), ["discern_navigate"]);
    for (const name of ["discern_navigate", "jev_navigate"]) {
      const result = await server.call(name, { ...PASSWORD_ARGS, password_env: "DISCERN_PASSWORD_MISSING" });
      assert.equal(result.isError, true);
      // The handler ran: this is its configuration error, not "Tool not found".
      assert.match(result.content[0].text, /DISCERN_BROWSER_PASSWORD_ORIGIN is not set/);
    }
    const unknown = await server.client.callTool({ name: "navigate", arguments: PASSWORD_ARGS }).then(
      (result) => result.content?.[0]?.text ?? "",
      (error) => error.message,
    );
    assert.match(unknown, /not found/);
    assert.equal(server.stderr().includes("deprecated"), false);
  } finally {
    await server.close();
  }
});

test("DISCERN_TOOL_NAMES=jev lists jev_navigate and keeps discern_navigate callable", async () => {
  const server = await connect(serverPath, { DISCERN_TOOL_NAMES: "jev" });
  try {
    assert.deepEqual(await server.names(), ["jev_navigate"]);
    const result = await server.call("discern_navigate", { ...PASSWORD_ARGS, password_env: "DISCERN_PASSWORD_MISSING" });
    assert.match(result.content[0].text, /DISCERN_BROWSER_PASSWORD_ORIGIN is not set/);
  } finally {
    await server.close();
  }
});

test("JEV_TOOL_NAMES aliases DISCERN_TOOL_NAMES with one stderr deprecation line", async () => {
  const server = await connect(serverPath, { JEV_TOOL_NAMES: "jev" });
  try {
    assert.deepEqual(await server.names(), ["jev_navigate"]);
    assert.equal(deprecations(server.stderr(), "JEV_TOOL_NAMES"), 1);
  } finally {
    await server.close();
  }
});

test("an invalid DISCERN_TOOL_NAMES refuses to start without echoing the value", async () => {
  const { code, stdout, stderr } = await run([], { DISCERN_TOOL_NAMES: "both-please" });
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /DISCERN_TOOL_NAMES must be "discern" or "jev"/);
  assert.equal(stderr.includes("both-please"), false);
});

test("the MCP server reads legacy JEV_ variables, warns once per name on stderr, and never prints values", async () => {
  const server = await connect(serverPath, {
    JEV_BROWSER_PASSWORD_ORIGIN: "https://acme.example",
    JEV_PASSWORD_ACME: SECRET,
  });
  try {
    for (let i = 0; i < 2; i++) {
      const result = await server.call("discern_navigate");
      // Past the origin check (read from JEV_BROWSER_PASSWORD_ORIGIN) to the
      // variable lookup: the legacy JEV_PASSWORD_ name resolves via DISCERN_.
      assert.match(result.content[0].text, /JEV_PASSWORD_MISSING is not set/);
    }
    const stderr = server.stderr();
    assert.equal(deprecations(stderr, "JEV_BROWSER_PASSWORD_ORIGIN"), 1);
    assert.equal(deprecations(stderr, "JEV_PASSWORD_ACME"), 1);
    assert.match(stderr, /rename it to DISCERN_PASSWORD_ACME/);
    assert.equal(stderr.includes(SECRET), false);
  } finally {
    await server.close();
  }
});

test("a JEV_/DISCERN_ conflict stops the server and the CLI with variable names only", async () => {
  const env = { JEV_PASSWORD_ACME: SECRET, DISCERN_PASSWORD_ACME: OTHER_SECRET };
  for (const args of [[], ["run", "Read the page", "https://acme.example"]]) {
    const { code, stdout, stderr } = await run(args, env);
    assert.notEqual(code, 0, `${args[0] ?? "server"} must refuse to start`);
    assert.equal(stdout, "", "stdout carries only the MCP protocol or result JSON");
    assert.match(stderr, /DISCERN_PASSWORD_ACME and JEV_PASSWORD_ACME are both set to different values/);
    assert.equal(stderr.includes(SECRET) || stderr.includes(OTHER_SECRET), false);
  }
});

test("the CLI applies legacy JEV_ names, warns once on stderr, and keeps stdout clean", async () => {
  // An unknown typing provider is refused before any browser or network work,
  // which proves the legacy name was read as DISCERN_BROWSER_TYPE_PROVIDER.
  const { code, stdout, stderr } = await run(["run", "Read the page", "https://acme.example"], { JEV_BROWSER_TYPE_PROVIDER: "bogus" });
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /DISCERN_BROWSER_TYPE_PROVIDER "bogus" is not a known typing provider/);
  assert.equal(deprecations(stderr, "JEV_BROWSER_TYPE_PROVIDER"), 1);

  const help = await run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^discern-browser run "<task>" <start-url>/);
});

test("ensure-chromium honors DISCERN_ and JEV_ skip variables directly", async () => {
  const script = join(root, "scripts", "ensure-chromium.mjs");
  // An empty PATH makes a real install attempt fail loudly, so a silent exit
  // proves the skip variable was honored.
  const attempt = (env) => run([], { PATH: "", ...env }, script);
  for (const name of ["DISCERN_BROWSER_SKIP_BROWSER_DOWNLOAD", "JEV_BROWSER_SKIP_BROWSER_DOWNLOAD"]) {
    const { code, stderr } = await attempt({ [name]: "1" });
    assert.equal(code, 0);
    assert.equal(stderr, "", `${name}=1 must skip the download`);
  }
  const control = await attempt({});
  assert.match(control.stderr, /chromium install failed/);
});

test("the @jkudish/jev-browser compat package lists jev_navigate and re-exports the library", async () => {
  // Lay the compat package out the way npm installs it: its own directory in
  // node_modules next to @jkudish/discern-browser (this checkout).
  const dir = await mkdtemp(join(tmpdir(), "discern-compat-"));
  try {
    const scope = join(dir, "node_modules", "@jkudish");
    await mkdir(scope, { recursive: true });
    await symlink(root, join(scope, "discern-browser"), "dir");
    await cp(join(root, "compat", "jev-browser"), join(scope, "jev-browser"), { recursive: true });
    const bin = join(scope, "jev-browser", "bin.js");

    const server = await connect(bin);
    try {
      assert.equal(server.client.getServerVersion()?.name, "discern-browser");
      assert.deepEqual(await server.names(), ["jev_navigate"]);
      const result = await server.call("discern_navigate", { ...PASSWORD_ARGS, password_env: "DISCERN_PASSWORD_MISSING" });
      assert.match(result.content[0].text, /DISCERN_BROWSER_PASSWORD_ORIGIN is not set/);
    } finally {
      await server.close();
    }

    const explicit = await connect(bin, { DISCERN_TOOL_NAMES: "discern" });
    try {
      assert.deepEqual(await explicit.names(), ["discern_navigate"], "an explicit setting wins over the compat default");
    } finally {
      await explicit.close();
    }

    const help = await run(["--help"], {}, bin);
    assert.equal(help.code, 0, "the compat bin runs the CLI in CLI mode");
    assert.match(help.stdout, /^discern-browser run/);

    const library = await import(pathToFileURL(join(scope, "jev-browser", "index.js")).href);
    const subpath = await import(pathToFileURL(join(scope, "jev-browser", "navigate.js")).href);
    assert.equal(typeof library.navigate, "function");
    assert.equal(subpath.navigate, library.navigate);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
