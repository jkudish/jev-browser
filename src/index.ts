#!/usr/bin/env node
// jev-browser: a Jev-driven browser agent.
//   jev-browser run "<task>" <url> [options]   CLI
//   jev-browser                                 MCP stdio server

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { navigate } from "./navigate.js";
import { runCli } from "./cli.js";
import {
  assertNoPlaywrightDebug,
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

// Resolved at runtime so the MCP handshake version always matches the package.
const { version: packageVersion } = createRequire(import.meta.url)("../package.json") as { version: string };

const server = new McpServer({ name: "jev-browser", version: packageVersion });

server.registerTool(
  "jev_navigate",
  {
    title: "Navigate a browser with Jev",
    description:
      "Give a task and a start URL; a Jev-driven agent navigates a real headless browser until the goal is met, " +
      "the stuck gate fires, or a budget (steps/seconds) is exhausted. Returns the final page in a chosen format " +
      "(text, markdown, html, or an aria snapshot), the full step trace with confidences, console/page/network " +
      "errors captured along the way, token usage with estimated cost, and a final screenshot. " +
      "The result also reports typing degradation explicitly (degraded, warnings with codes, typing_provider, typing_model), so a failed typing generator is visible instead of silently typing keyword soup. " +
      "For logins: with JEV_BROWSER_PASSWORD_ORIGIN set in this server's environment, password_file or password_env " +
      "fills native password fields on that origin only, without the value ever entering model context, traces, or " +
      "screenshots; never put the password value itself in any argument or in the task.",
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
      max_chars: z.number().int().min(100).optional().describe("Override the format's default character cap."),
      screenshot: z.enum(["final", "none"]).optional().describe("Final viewport JPEG. Default 'final'. Suppressed automatically after a password fill."),
      password_file: z
        .string()
        .min(1)
        .max(4096)
        .optional()
        .describe(
          "Password fill: absolute path inside the handoff directory (default ~/.jev-browser/handoff; override with " +
            "JEV_BROWSER_HANDOFF_DIR) holding the password, written by your secret manager (e.g. " +
            "op read --no-newline --out-file ...). The file is consumed and deleted at run start. " +
            "Requires JEV_BROWSER_PASSWORD_ORIGIN in this server's environment. Never put the password value itself here.",
        ),
      password_env: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe(
          "Password fill: name of a JEV_PASSWORD_* environment variable visible to this server. Naming a variable " +
            "with that prefix is the operator's opt-in; any other name is rejected. Requires " +
            "JEV_BROWSER_PASSWORD_ORIGIN in this server's environment.",
        ),
    },
  },
  async ({ task, start_url, ...rest }, extra) => {
    // Credential delivery resolves before the browser launches. Every failure
    // here is a configuration error and is reported without ever quoting file
    // contents or variable values.
    let password: { value: string; origin: string } | undefined;
    if (rest.password_file || rest.password_env) {
      try {
        if (rest.password_file && rest.password_env) {
          throw new Error("pass at most one of password_file and password_env");
        }
        const rawOrigin = process.env.JEV_BROWSER_PASSWORD_ORIGIN;
        if (!rawOrigin) {
          throw new Error(
            "password fill requested but JEV_BROWSER_PASSWORD_ORIGIN is not set; add it to this server's " +
              "environment as an exact origin (e.g. https://acme.com)",
          );
        }
        const origin = parseTrustedOrigin(rawOrigin);
        if (!origin) {
          throw new Error("JEV_BROWSER_PASSWORD_ORIGIN must be an exact origin like https://acme.com (http is allowed only on localhost)");
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
      },
      extra.signal,
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

await server.connect(new StdioServerTransport());
console.error(`[jev-browser] ready — Jev model ${process.env.JEV_BROWSER_MODEL ?? "jev-latest"}`);
