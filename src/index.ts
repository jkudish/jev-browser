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
      "errors captured along the way, token usage with estimated cost, and a final screenshot.",
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
        .describe("Whether the agent may type into fields (uses the configured small model, or a keyword fallback). Default true."),
      format: z
        .enum(["text", "markdown", "html", "aria"])
        .optional()
        .describe(
          "Final page payload format: text (default, 8k chars), markdown (16k, via turndown), " +
            "html (1MB, for app-side parsing), aria (16k, Playwright aria snapshot YAML).",
        ),
      max_chars: z.number().int().min(100).optional().describe("Override the format's default character cap."),
      screenshot: z.enum(["final", "none"]).optional().describe("Final viewport JPEG. Default 'final'."),
      cookies: z
        .array(
          z.object({
            name: z.string().min(1),
            value: z.string(),
            domain: z.string().optional().describe("Defaults to the start URL's host."),
            path: z.string().optional().describe("Defaults to '/'."),
          }),
        )
        .optional()
        .describe(
          "Cookies added before the first navigation, e.g. a session cookie so the run starts behind a login. " +
            "The agent never types into password fields, so this is the only way onto an authenticated page.",
        ),
    },
  },
  async ({ task, start_url, ...rest }, extra) => {
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
        cookies: rest.cookies,
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
