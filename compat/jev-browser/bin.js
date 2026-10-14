#!/usr/bin/env node
// jev-browser compatibility bin. Runs discern-browser in the same mode it was
// called in (MCP stdio server, --http, `run` CLI, or --help: discern-browser
// reads process.argv itself) and lists the legacy jev_navigate tool name
// unless the tool-name setting was chosen explicitly. Removed in 2.0.
if (!process.env.DISCERN_TOOL_NAMES && !process.env.JEV_TOOL_NAMES) {
  process.env.DISCERN_TOOL_NAMES = "jev";
}
await import("@jkudish/discern-browser/bin");
