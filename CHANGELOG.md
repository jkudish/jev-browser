# Changelog

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
