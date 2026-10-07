# Contributing

Thanks for considering a contribution. This package is deliberately small: one MCP tool, `discern_navigate`, that navigates a browser with a judgment model making the decisions (TypeSafe's Jev by default, or Cloudflare's Clef or OpenAI Decisions) and code owning the loop.

## Development

```bash
npm install
npm run build
npm run typecheck
```

Node.js 22 or newer. TypeScript, ESM. Playwright drives the browser; the Vercel AI SDK drives the typing generator (any provider); [`@jkudish/discern-agent-tools`](https://github.com/jkudish/discern-agent-tools) sends and validates the judgments.

## Tests

```bash
npm test            # unit, transport, HTTP, and MCP-client tests, offline
npm run test:e2e    # live navigation tests, requires TYPESAFE_API_KEY
```

Unit tests run everywhere, including CI. End-to-end tests navigate real Wikipedia and DuckDuckGo pages; they run in CI only when a `TYPESAFE_API_KEY` secret is configured, and locally only when the variable is set. Both suites must pass before a pull request can merge.

The DuckDuckGo test is informational on status but asserts clean termination: it exists because DuckDuckGo's accessibility tree hides its search input, which is why element extraction reads the DOM directly. Keep it passing.

## Pull requests

- Keep changes small and scoped to one behavior.
- Question designs live in `src/questions.ts` and nowhere else. Link the relevant TypeSafe doc when you change one.
- Changes to loop policy (stop gates, recovery, budgets) need evidence: run the e2e suite before and after and include both traces in the PR.
- New action types or a wider action space need an issue first describing the task shape that needs them and why the current set does not cover it.
- Update the README example and limits section for any behavioral change.

## Notes

- Read configuration only through `DISCERN_*` names. Legacy `JEV_*` names are normalized into them at startup (`src/env.ts`); do not read a `JEV_` name directly. The one exception is `scripts/ensure-chromium.mjs`, which runs at postinstall before any package code.
- The compatibility package in `compat/jev-browser/` is published separately and is not part of the root package's `files`.

- The action space is capped by the Choice limit of both judgment providers (255 options; 240 elements plus controls). Anything that widens the space must respect that bound.
- Every result includes token usage and estimated cost; keep that true for any new judgment call.
- Failure behavior is fail-closed: errors become failed steps or clean statuses, never hangs.
