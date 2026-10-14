# @jkudish/jev-browser

`@jkudish/jev-browser` is now [`@jkudish/discern-browser`](https://github.com/jkudish/discern-browser). This package keeps 0.x setups working through 1.x and is removed in 2.0.

- The `jev-browser` bin runs `discern-browser` in the mode you called it in (MCP server, `--http`, or `run` CLI). It sets `DISCERN_TOOL_NAMES=jev` when neither `DISCERN_TOOL_NAMES` nor `JEV_TOOL_NAMES` is set, so `tools/list` shows `jev_navigate`; `discern_navigate` is callable too.
- `import { navigate } from "@jkudish/jev-browser"` and `@jkudish/jev-browser/dist/navigate.js` re-export the discern-browser library.
- `JEV_*` environment variables keep working through 1.x, with one stderr deprecation line each.

To migrate, install `@jkudish/discern-browser`, rename `JEV_*` variables to `DISCERN_*`, and call `discern_navigate`. See the [migration guide](https://github.com/jkudish/discern-browser#migrating-from-jev-browser).
