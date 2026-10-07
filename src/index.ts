#!/usr/bin/env node
// discern-browser: a browser agent driven by structured model judgments.
//   discern-browser run "<task>" <url> [options]   CLI
//   discern-browser                                 MCP stdio server

import { McpServer, type ListToolsResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createRequire } from "node:module";
import { navigate } from "./navigate.js";
import { runCli } from "./cli.js";
import { applyDiscernEnv, toolNamesFrom, type ToolNames } from "./env.js";
import type { SeedCookie } from "./lib.js";
import {
  assertNoPlaywrightDebug,
  COOKIE_ENV_PREFIX,
  handoffDir,
  parseTrustedOrigin,
  readHandoffSecret,
  readSecretFromEnv,
  validateSecretBuffer,
} from "./password.js";

if (process.argv[2] === "run") {
  process.exit(await runCli(process.argv.slice(3)));
}
if (process.argv[2] === "--help" || process.argv[2] === "-h") {
  process.exit(await runCli(["--help"]));
}

// MCP server mode. Legacy JEV_ variables are normalized into their DISCERN_
// names once, before anything reads the environment; a conflict or an
// invalid DISCERN_TOOL_NAMES refuses to start with a fixed-string error.
let listedNames: ToolNames;
try {
  applyDiscernEnv();
  listedNames = toolNamesFrom(process.env);
} catch (error) {
  console.error(`[discern-browser] ${(error as Error).message}`);
  process.exit(1);
}

// Both names are registered and callable through 1.x; tools/list advertises
// one of them (DISCERN_TOOL_NAMES). The jev_ name is removed in 2.0.
const TOOL_NAME = "discern_navigate";
const LEGACY_TOOL_NAME = "jev_navigate";
const hiddenToolName = listedNames === "jev" ? TOOL_NAME : LEGACY_TOOL_NAME;

// Resolved at runtime so the MCP handshake version always matches the package.
const { version: packageVersion } = createRequire(import.meta.url)("../package.json") as { version: string };

// Tools are declared once at module scope and replayed onto a fresh McpServer
// per stdio connection or per stateless HTTP request (see createServer below).
type RegisterTool = McpServer["registerTool"];
const toolRegistrations: Parameters<RegisterTool>[] = [];
const server = {
  registerTool: ((...args: Parameters<RegisterTool>) => {
    toolRegistrations.push(args);
  }) as unknown as RegisterTool,
};

export function createServer(): McpServer {
  // The tool list is static, so it advertises no listChanged capability and
  // no client has a reason to hold a subscriptions/listen stream open (which
  // would otherwise occupy an HTTP concurrency slot without doing any work).
  const instance = new McpServer(
    { name: "discern-browser", version: packageVersion },
    { capabilities: { tools: { listChanged: false } } },
  );
  for (const args of toolRegistrations) (instance.registerTool as (...a: Parameters<RegisterTool>) => unknown)(...args);
  hideFromToolList(instance, hiddenToolName);
  return instance;
}

type ListToolsHandler = (request: unknown, ctx: unknown) => Promise<ListToolsResult>;

/**
 * Keeps a registered tool callable but drops it from tools/list. McpServer
 * has no public listed-versus-callable split (a disabled tool also rejects
 * calls), so this wraps the SDK's own tools/list handler, read through the
 * Protocol class's protected _getRequestHandler accessor. This is the only
 * non-public SDK access in the package, and discern-mcp uses the same
 * accessor (verified on @modelcontextprotocol/server 2.3.1). If a future SDK
 * removes it, the server still starts and lists both names, with one stderr
 * line, rather than failing every connection. test/mcp.test.mjs lists tools
 * and calls the hidden name over a real client, so an SDK change fails CI.
 */
let warnedUnhidden = false;
function hideFromToolList(instance: McpServer, hidden: string): void {
  const original = (instance.server as unknown as { _getRequestHandler?(method: string): ListToolsHandler | undefined })._getRequestHandler?.("tools/list");
  if (typeof original !== "function") {
    if (!warnedUnhidden) {
      warnedUnhidden = true;
      process.stderr.write("[discern-browser] this MCP SDK version cannot hide the tool alias; listing both discern_navigate and jev_navigate.\n");
    }
    return;
  }
  instance.server.removeRequestHandler("tools/list");
  instance.server.setRequestHandler("tools/list", async (request, ctx) => {
    const result = await original(request, ctx);
    return { ...result, tools: result.tools.filter((tool) => tool.name !== hidden) };
  });
}

server.registerTool(
  TOOL_NAME,
  {
    title: "Navigate a browser with Discern",
    description:
      "Give a task and a start URL; an agent driven by structured model judgments (TypeSafe Jev by default, or Cloudflare " +
      "Clef or OpenAI Decisions) navigates a real headless browser until the goal is met, " +
      "the stuck gate fires, or a budget (steps/seconds) is exhausted. Returns the final page in a chosen format " +
      "(text, markdown, html, or an aria snapshot), the full step trace with confidences, console/page/network " +
      "errors captured along the way, token usage with estimated cost, and a final screenshot. " +
      "The result also reports typing degradation explicitly (degraded, warnings with codes, typing_provider, typing_model), so a failed typing generator is visible instead of silently typing keyword soup. " +
      "For logins: with DISCERN_BROWSER_PASSWORD_ORIGIN set in this server's environment, password_file or password_env " +
      "fills native password fields on that origin only, without the value ever entering model context, traces, or " +
      "screenshots; never put the password value itself in any argument or in the task. To start already logged in, " +
      "seed a session cookie instead via cookie_file or cookie_env (same reference-based delivery and redaction).",
    inputSchema: {
      task: z.string().min(1).describe("What the agent should accomplish, in natural language."),
      start_url: z
        .string()
        .url()
        .refine((v) => /^https?:\/\//.test(v), "start_url must be an http(s) URL")
        .describe("Where to start."),
      max_steps: z.number().int().min(1).max(100).optional().describe("Hard step cap. Default 24."),
      max_seconds: z.number().min(10).max(600).optional().describe("Wall-clock cap in seconds. Default 180."),
      allow_typing: z
        .boolean()
        .optional()
        .describe("Whether the agent may type into fields. Uses the configured small model; when it fails, ordinary fields are left empty with a warning and search boxes fall back to a keyword heuristic. Default true."),
      format: z
        .enum(["text", "markdown", "html", "aria"])
        .optional()
        .describe(
          "Final page payload format: text (default, 8k chars), markdown (16k, via turndown), " +
            "html (1MB, for app-side parsing), aria (16k, Playwright aria snapshot YAML).",
        ),
      max_chars: z.number().int().min(100).max(1_000_000).optional().describe("Override the format's default character cap (at most 1,000,000, the html format's default)."),
      screenshot: z.enum(["final", "none"]).optional().describe("Final viewport JPEG. Default 'final'. Suppressed automatically after a password fill."),
      password_file: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          "Password fill: absolute path inside the handoff directory (default ~/.discern-browser/handoff; override with " +
            "DISCERN_BROWSER_HANDOFF_DIR) holding the password, written by your secret manager (e.g. " +
            "op read --no-newline --out-file ...). The file is consumed and deleted at run start. " +
            "Requires DISCERN_BROWSER_PASSWORD_ORIGIN in this server's environment. Never put the password value itself here.",
        ),
      password_env: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe(
          "Password fill: name of a DISCERN_PASSWORD_* environment variable visible to this server. Naming a variable " +
            "with that prefix is the operator's opt-in; any other name is rejected (the legacy JEV_PASSWORD_* name of the " +
            "same variable also works through 1.x). Requires " +
            "DISCERN_BROWSER_PASSWORD_ORIGIN in this server's environment.",
        ),
      cookie_file: z
        .array(
          z.object({
            name: z.string().min(1).max(256).describe("Cookie name, e.g. session."),
            file: z
              .string()
              .min(1)
              .max(4096)
              .describe(
                "Path inside the handoff directory (default ~/.discern-browser/handoff; override with DISCERN_BROWSER_HANDOFF_DIR) " +
                  "holding this cookie's value, written by your secret manager. The file is consumed and deleted at run start.",
              ),
            domain: z.string().max(256).optional().describe("Omit (recommended): host-only on the start URL's exact host. '.example.com' (leading dot) also matches subdomains."),
            path: z.string().max(1024).optional().describe("Defaults to '/'."),
            secure: z.boolean().optional().describe("Defaults to true on https start URLs. Forced true for __Host-/__Secure- names and sameSite \"None\"; secure: false cannot strip a forced flag."),
            httpOnly: z.boolean().optional().describe("Defaults to true; set false only if the site's own scripts must read this cookie."),
            sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("Defaults to 'Lax'."),
          }),
        )
        .min(1)
        .optional()
        .describe(
          "Seed cookies so the run starts behind a login, e.g. a session cookie captured elsewhere. " +
            "Values arrive by reference and are redacted like passwords. Never put a cookie value itself in any argument.",
        ),
      cookie_env: z
        .array(
          z.object({
            name: z.string().min(1).max(256).describe("Cookie name, e.g. session."),
            env: z.string().min(1).max(256).describe("Name of a DISCERN_COOKIE_* environment variable visible to this server (legacy JEV_COOKIE_* names also work through 1.x)."),
            domain: z.string().max(256).optional().describe("Omit (recommended): host-only on the start URL's exact host. '.example.com' (leading dot) also matches subdomains."),
            path: z.string().max(1024).optional().describe("Defaults to '/'."),
            secure: z.boolean().optional().describe("Defaults to true on https start URLs. Forced true for __Host-/__Secure- names and sameSite \"None\"; secure: false cannot strip a forced flag."),
            httpOnly: z.boolean().optional().describe("Defaults to true; set false only if the site's own scripts must read this cookie."),
            sameSite: z.enum(["Strict", "Lax", "None"]).optional().describe("Defaults to 'Lax'."),
          }),
        )
        .min(1)
        .optional()
        .describe(
          "Seed cookies with values from DISCERN_COOKIE_* environment variables; naming a variable with that prefix is " +
            "the operator's opt-in, any other name is rejected. Redacted like passwords.",
        ),
    },
  },
  async ({ task, start_url, ...rest }, ctx) => {
    // Credential delivery resolves before the browser launches. Every failure
    // here is a configuration error and is reported without ever quoting file
    // contents or variable values. Seed cookies follow the password's
    // reference-based ingress exactly: the value arrives through a consumed
    // one-shot handoff file or a DISCERN_COOKIE_* variable name, never as an
    // argument a host could log.
    let password: { value: string; origin: string } | undefined;
    if (rest.password_file || rest.password_env) {
      try {
        if (rest.password_file && rest.password_env) {
          throw new Error("pass at most one of password_file and password_env");
        }
        const rawOrigin = process.env.DISCERN_BROWSER_PASSWORD_ORIGIN;
        if (!rawOrigin) {
          throw new Error(
            "password fill requested but DISCERN_BROWSER_PASSWORD_ORIGIN is not set; add it to this server's " +
              "environment as an exact origin (e.g. https://acme.com)",
          );
        }
        const origin = parseTrustedOrigin(rawOrigin);
        if (!origin) {
          throw new Error("DISCERN_BROWSER_PASSWORD_ORIGIN must be an exact origin like https://acme.com (http is allowed only on localhost)");
        }
        assertNoPlaywrightDebug();
        const secret = rest.password_file
          ? validateSecretBuffer(await readHandoffSecret(rest.password_file, handoffDir()), "password file")
          : validateSecretBuffer(readSecretFromEnv(rest.password_env!), "password env");
        password = { value: secret, origin };
      } catch (error) {
        return { content: [{ type: "text", text: (error as Error).message }], isError: true };
      }
    }
    let cookies: SeedCookie[] | undefined;
    const cookieFileSpecs = rest.cookie_file ?? [];
    const cookieEnvSpecs = rest.cookie_env ?? [];
    if (cookieFileSpecs.length > 0 || cookieEnvSpecs.length > 0) {
      try {
        if (cookieFileSpecs.length > 0 && cookieEnvSpecs.length > 0) {
          throw new Error("pass at most one of cookie_file and cookie_env");
        }
        const specs: Array<{ name: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: "Strict" | "Lax" | "None"; file?: string; env?: string }> = [
          ...cookieFileSpecs,
          ...cookieEnvSpecs,
        ];
        const names = new Set(specs.map((s) => s.name));
        if (names.size !== specs.length) {
          throw new Error("cookie names must be unique within one run");
        }
        assertNoPlaywrightDebug();
        cookies = await Promise.all(
          specs.map(async (s) => {
            const buf = s.file !== undefined ? await readHandoffSecret(s.file, handoffDir(), "cookie_file") : readSecretFromEnv(s.env!, { prefix: COOKIE_ENV_PREFIX, what: "cookie_env" });
            return {
              name: s.name,
              value: validateSecretBuffer(buf, `cookie "${s.name}"`),
              domain: s.domain,
              path: s.path,
              secure: s.secure,
              httpOnly: s.httpOnly,
              sameSite: s.sameSite,
            };
          }),
        );
      } catch (error) {
        return { content: [{ type: "text", text: (error as Error).message }], isError: true };
      }
    }
    const result = await navigate(
      {
        task,
        startUrl: start_url,
        maxSteps: rest.max_steps,
        maxSeconds: rest.max_seconds,
        allowTyping: rest.allow_typing,
        format: rest.format,
        maxChars: rest.max_chars,
        screenshot: rest.screenshot,
        password,
        cookies,
      },
      ctx.mcpReq.signal,
    );

    const { screenshot_base64_jpeg, ...json } = result as Record<string, unknown>;
    const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
      { type: "text", text: JSON.stringify(json, null, 2) },
    ];
    if (typeof screenshot_base64_jpeg === "string") {
      content.push({ type: "image", data: screenshot_base64_jpeg, mimeType: "image/jpeg" });
    }
    return { content, isError: json.status === "error" };
  },
);
// The legacy name replays the same config and handler.
const [, navigateConfig, navigateHandler] = toolRegistrations.find(([name]) => name === TOOL_NAME)!;
toolRegistrations.push([LEGACY_TOOL_NAME, navigateConfig, navigateHandler] as Parameters<RegisterTool>);

if (process.argv.includes("--http") || process.env.DISCERN_BROWSER_TRANSPORT === "http") {
  const { serveHttp } = await import("./http.js");
  const { url } = await serveHttp(createServer);
  console.error(`[discern-browser] ready — judgment model ${process.env.DISCERN_BROWSER_MODEL ?? "jev-latest"}, tool ${listedNames === "jev" ? LEGACY_TOOL_NAME : TOOL_NAME}, stateless HTTP at ${url}`);
} else {
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  serveStdio(createServer);
  console.error(`[discern-browser] ready — judgment model ${process.env.DISCERN_BROWSER_MODEL ?? "jev-latest"}, tool ${listedNames === "jev" ? LEGACY_TOOL_NAME : TOOL_NAME}`);
}
