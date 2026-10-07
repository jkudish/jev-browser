# Changelog

## 1.0.0 (unreleased)

Renamed from `@jkudish/jev-browser` to `@jkudish/discern-browser`, because the package now runs OpenAI's Decisions API as well as TypeSafe's Jev model. Every 0.x name keeps working through 1.x and is removed in 2.0. See the README's [migration section](README.md#migrating-from-jev-browser).

- Cloudflare Clef: `DISCERN_PROVIDER=cloudflare` with `DISCERN_BROWSER_MODEL=clef` or `clef-flash` runs Cloudflare's Clef decision models, via `@jkudish/discern-agent-tools`.
- Rename: package `@jkudish/discern-browser`, binary `discern-browser`, MCP `serverInfo.name` `discern-browser`, MCP tool `discern_navigate`, and `DISCERN_*` environment variables. Judgment transport is now `@jkudish/discern-agent-tools` 1.0.
- `jev_navigate` stays callable as an unlisted alias. `DISCERN_TOOL_NAMES=jev` lists `jev_navigate` instead, with `discern_navigate` still callable; any value other than `discern` or `jev` refuses to start.
- Every `JEV_<X>` variable aliases `DISCERN_<X>`, including `JEV_PASSWORD_*` and `JEV_COOKIE_*` names given to `password_env` and `cookie_env`. Each legacy variable prints one deprecation line to stderr, never stdout. `DISCERN_<X>` wins; two different non-empty values are a configuration error that names both variables and never their values. The Chromium postinstall honors both `DISCERN_BROWSER_SKIP_BROWSER_DOWNLOAD` and `JEV_BROWSER_SKIP_BROWSER_DOWNLOAD`.
- Results add `judgment_provider` and `usage.judgment_calls`. `jev_provider` and `usage.jev_calls` stay with identical values, deprecated.
- Library: `DiscernTransport`, `DiscernTransportInput`, `DiscernTransportReply`, `DiscernAnswer`, `DiscernUsage`, and `NavigateResult` are exported; the `Jev*` names stay as deprecated aliases. `navigate()` now returns `Promise<NavigateResult>` instead of `Promise<any>`; undeclared fields are still typed `any`.
- The handoff directory default is `~/.discern-browser/handoff`. An existing `~/.jev-browser/handoff` is still used when the new one does not exist.
- Elements are stamped `data-discern-id` instead of `data-jev-id` in visited pages.
- OpenAI Decisions judgments with `DISCERN_PROVIDER=openai`, keyed by `DISCERN_OPENAI_API_KEY` (or `OPENAI_API_KEY`, which also drives typing). Never auto-detected; `jev-latest` maps to `gpt-6-luna`. The 0.85 stop thresholds were tuned on Jev and are unverified on it. Cost estimates use the answering carrier's input price.
- New compatibility package `@jkudish/jev-browser` 1.0.0 (in `compat/jev-browser/`): its `jev-browser` binary runs discern-browser in the same mode and lists `jev_navigate` unless `DISCERN_TOOL_NAMES` (or its legacy alias `JEV_TOOL_NAMES`) is set, and it re-exports the library.

## 0.8.4

- The browser can act on ARIA menu items, options, tabs, switches, and radios. Same-text controls show their role, and visible dialog updates count as page changes. Reimplemented from ideas in [#22](https://github.com/jkudish/jev-browser/pull/22) by [@yaukitdev1-cpu](https://github.com/yaukitdev1-cpu).
- Jev transport updated to `@jkudish/jev-agent-tools` 0.2.0: OpenRouter `jev-latest` follows `~typesafe/jev-latest`, and Vercel accepts the opt-in `JEV_VERCEL_ZERO_DATA_RETENTION` routing setting.
- Dependency updates: MCP SDK 2.3.1 and AI SDK 7.0.128 with typing-provider patches.

## 0.8.3

- Updated AI SDK typing dependencies.

## 0.8.2

- TypeSafe requests now retry transient HTTP failures and report the effective model through jev-agent-tools 0.1.4. Updated typing-provider dependencies.

## 0.8.1

- Goal judgment now reads what a person sees — the open modal dialog, else the text in the viewport — instead of the start of the body, which is often navigation or banners; redacted credential runs keep the page-start excerpt. Via [#21](https://github.com/jkudish/jev-browser/pull/21).
- Dependency updates: `ai` 7.0.122, @ai-sdk provider patches, `@modelcontextprotocol/server` + `node` 2.2.0.

## 0.8.0

- Opt-in stateless Streamable HTTP: `jev-browser --http` (or `JEV_BROWSER_TRANSPORT=http`) serves MCP 2026-07-28 per request and 2025-era clients through the SDK's stateless fallback, with no sessions, on `PORT` (default 8080) at `/mcp`, with `/health`. `HOST` defaults to loopback; binding beyond it is explicit. `JEV_BROWSER_AUTH_TOKEN` gates it with a bearer token and is required unless `HOST` is loopback; Host/Origin rebinding guards answer fixed-string 403s. Concurrent requests are capped at `JEV_BROWSER_MAX_CONCURRENCY` (default 4, since each in-flight call holds a headless Chromium) with `429` backpressure, and a client that disconnects mid call aborts its navigation and frees the slot. The tool list is static: no `listChanged` is advertised and `subscriptions/listen` is refused, so an idle listener cannot occupy a slot. `jev_navigate`'s `max_chars` is capped at 1,000,000. Stdio stays the default.
- Internal: `@modelcontextprotocol/sdk` 1.x replaced by the v2 packages `@modelcontextprotocol/server` and `@modelcontextprotocol/node` 2.1.0; the tool registers once and a fresh server replays it per connection or request.
- Dependency updates: `@ai-sdk/openai` 4.0.78 and `ai` 7.0.116.

## 0.7.0

- Typing providers upgraded to the AI SDK 7 provider packages (v4), which removes the HIGH undici advisory from the dependency tree; Gemini Flash typing no longer returns empty text because reasoning consumed the output budget. Via [#19](https://github.com/jkudish/jev-browser/pull/19).
- Internal: zod 4 and TypeScript 7. Advertised input schemas drop `additionalProperties: false` under zod 4's JSON Schema conversion; unknown keys are still stripped at runtime. Via [#19](https://github.com/jkudish/jev-browser/pull/19).
- Dependency updates across the board, including `@ai-sdk/google` 2.0.99.
- Judgment answers with many weighted options are no longer rejected for two-decimal rounding drift in their probability sum, via `@jkudish/jev-agent-tools` 0.1.3 ([jev-agent-tools#3](https://github.com/jkudish/jev-agent-tools/pull/3)); previously a 60-option answer summing to 1.01 could fail a live run.
- Ships an agent skill inside the package: `skills/jev-browser/` is included in the npm tarball, so coding agents get `jev_navigate` usage policy — when a real browser beats a static fetch, evidence-grade recording — without hand-written prompts.

## 0.6.1

- Docs: Providers section in the README, aligned install requirements, and the Jev MCP family reference updated to eleven tools.

## 0.6.0

- Judgment transport now uses `@jkudish/jev-agent-tools` for provider selection and answer validation; browser run errors remain fail-loud.
- Transport drivers: the four judgment transports (TypeSafe, OpenRouter, Cloudflare, Vercel) are now run-bound drivers behind one registry. Typing providers are unchanged.
- An unknown `JEV_PROVIDER` now errors instead of silently falling through to auto-detection; the no-provider diagnostic names all four credential sets.
- Every answer is validated at a shared boundary before tokens are credited or an action executes: missing or malformed answers error the run, and transport errors from built-in providers no longer include raw response bodies.
- Removed the select-option fallback to the first option; a malformed option judgment errors the run without selecting anything.
- Library callers can inject a transport with `NavigateOptions.transport`; results report its name and effective model. `est_cost_usd` stays a Jev-token estimate.
- Docs: provider setup notes and a pointer to the shared package's add-a-provider guide.


## 0.5.0

- Cloudflare challenges and hard blocks are now detected and named: the run stops with status `blocked` plus `bot_protection` evidence and guidance, instead of burning steps against a wall. Challenges get a short window to clear first.
- Cookie seeding (via PR #9, remediated): seed cookies before the first navigation so a run can start behind a login. Values arrive by file or env reference only, never argv, and are redacted like passwords from every state, trace, error, and payload.
- CLI argument errors print a one-line message and exit 1 instead of an uncaught stack trace (from PR #9).
- Typing degradation is visible (#2): every result carries `degraded`, `warnings`, `typing_provider`, and `typing_model`. Warnings carry a code, never response bodies, and a completed fallback is not an error.
- `JEV_BROWSER_TYPE_PROVIDER` is strict (#2): it selects only that provider, and an unknown name or bad key is a configuration error before the run starts. Previously it silently fell through to another provider.
- Typing fallbacks split by field kind (#2): ordinary fields type nothing and record an action error instead of keyword soup; search fields keep the keyword heuristic, labeled as a fallback.
- OpenRouter typing disables reasoning and raises the output cap to 256 tokens, so reasoning models can no longer spend the whole budget on hidden tokens and return empty text.
- `JEV_BROWSER_TYPE_BASE_URL` is validated up front and honored by every typing provider, so private gateways work uniformly. `@ai-sdk/google` is upgraded to 2.x; 1.x could not generate at all.
- Node.js 22 or newer is required (was 20); the locked `ai@7` dependency declares it.
- README fixes: correct OpenRouter typing default model, the `JEV_BROWSER_TYPE_MODEL` example, and the typing-cost claim.
- Form controls resolve accessible names (AccName 1.2 precedence) (#1); plain `<label for>` login fields no longer vanish from the action space.
- A successful type action records a truthful outcome, so the stuck watcher no longer misreads a filled field as a no-op; repeat recovery keys off machine state instead of display strings.
- `<select>` dropdowns select by DOM option index, so a scrubbed or truncated label can never become the selection key.
- Password fill for logins: the model never sees or types the password. Delivery is by file or env reference (`--password-file`, `password_file`, `password_env`), fills are bound to a trusted origin and never submit, and every echo is redacted from all output.
- Form actions are explicit (#7): `type_eN` types without submitting, `submit_eN` submits, and `search_eN` types and searches in one action. Filling one field of a multi-field form no longer submits it.
- Library callers can pass an existing Playwright `page` and keep ownership of its lifecycle; recording is refused on injected pages.
- Public library entry: `import { navigate } from "@jkudish/jev-browser"`. Model and provider resolve per run, so importing has no side effects and concurrent runs report their own values.
- `--record` scratch directories live under the OS temp directory and are cleaned up, instead of leaking `jev-browser-record-*` in the working directory.

## 0.4.1

- Fixed: the Chromium download runs on install again; the `postinstall` script was declared outside `scripts`, so npm ignored it. Found and verified in clean containers by MrJev in [#6](https://github.com/jkudish/jev-browser/pull/6).

## 0.4.0

- Recording support: `--record <path.webm|dir>` on the CLI and `recordDir` on `navigate()` capture a video of the page; results include `video_path` and per-step `t_ms` timestamps.
- OpenRouter typing default moved to `google/gemini-2.5-flash-lite`: the previous default returned empty output for short prompts, and the Gemini default is faster and cheaper than the alternatives measured.

## 0.3.0

- Cloudflare Workers AI support: with `CLOUDFLARE_API_TOKEN` (or `JEV_CLOUDFLARE_API_TOKEN`) and `CLOUDFLARE_ACCOUNT_ID` set, judgments run through Cloudflare at the `typesafe/jev` alias; `JEV_PROVIDER=cloudflare` forces it.
- Vercel AI Gateway support: with `AI_GATEWAY_API_KEY` set, judgments run through the AI SDK evaluate API at `typesafe-ai/jev`; `JEV_PROVIDER=vercel` forces it.
- Provider resolution order: TypeSafe direct, OpenRouter, Cloudflare, Vercel.

## 0.2.0

- OpenRouter support: with only an `OPENROUTER_API_KEY`, Jev judgments route through OpenRouter's Decisions API (alpha), so one key powers the entire package, typing included. `JEV_PROVIDER` forces `typesafe` or `openrouter`.
- Results now report the transport used (`jev_provider`, resolved `model`).

## 0.1.0

Initial release, published to npm as `@jkudish/jev-browser` (the unscoped `jev-browser` name belongs to another project).

- `jev_navigate` MCP tool: task plus start URL in, final page plus step trace, captured console and network errors, usage and estimated cost, and a final screenshot out.
- One primary Jev call per step: an action Choice over up to 240 page elements plus scroll, back, and done; a goal judgment; a stuck judgment. A select action adds one second-stage Choice for its option.
- Stop gates run before action execution: agent `done`, goal probability, stuck probability, step budget (24), time budget (180 s), caller cancellation.
- Typing cascade through the Vercel AI SDK: OpenAI, OpenRouter, Anthropic, Google, or any OpenAI-compatible endpoint, with a keyword fallback that is labeled in the trace.
- CLI (`jev-browser run`) and library import (`dist/navigate.js`) alongside the MCP server.
- Page payload formats: text, markdown, html, aria snapshot, with per-format caps and truncation flags.

No versioning policy has been declared yet; treat 0.x APIs as unstable.
