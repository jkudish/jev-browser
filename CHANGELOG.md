# Changelog

## Unreleased

- Form controls now resolve an accessible name (AccName 1.2 precedence: `aria-labelledby` refs, `aria-label`, all associated native labels via the `.labels` API, then placeholder and title). Plain `<label for>` login forms no longer drop out of the action space, which previously made their inputs invisible and untypeable (#1).
- A successful type action now records a truthful outcome (`typed into "Username"; no visible page change`) instead of `no visible change`, so the stuck watcher no longer misreads a filled field as a no-op. Repeat recovery now keys off machine state (a repeated action whose only effect was the fill, or a genuine no-op) instead of matching the display string, and no longer terminates on a `done` alternate with negligible probability.

- Text and form actions are three explicit choices instead of typing that always pressed Enter (#7). `search_eN` types the query and runs the search in one action, stamped only on structurally search-like fields (`input[type=search]` or `role=searchbox`, never by label or form heuristics), replacing the per-field action twins there. Submit controls (`button[type=submit]`, `input[type=submit]`, and a `button` with no type attribute inside a form, where it defaults to submit) are offered as `submit_eN` instead of `click_eN`. Every other single-line text field offers `type_eN` (type without submitting) alongside `submit_eN` (press Enter on that field), so filling one field of a multi-field form no longer submits it. Submit button inputs also pick up their visible label from the `value` attribute, and the repeat recovery no longer switches to `done`, which is a stop gate rather than an executable action.
- Public library entry: `import { navigate } from "@jkudish/jev-browser"` now works. The package root exports `navigate` and the `NavigateOptions`, `StepRecord`, `ConsoleEvent`, and `JevUsage` types side-effect free; the pre-existing `@jkudish/jev-browser/dist/navigate.js` deep import keeps working. The MCP server and CLI remain the `jev-browser` bin, and client configs are unchanged.
- Model and provider are resolved per run instead of at import time, so importing the library has no configuration side effects and concurrent runs report their own provider and model, never another run's.
- CLI recording scratch directories for `--record file.webm` are created under the OS temp directory and removed after the video is copied out, instead of leaking a `jev-browser-record-*` directory in the working directory.

## 0.4.1

- Fixed: the Chromium download now runs on install. The `postinstall` script was declared outside the `scripts` object, so npm ignored it; installs succeeded but the first run on a clean machine failed with `Executable doesn't exist`. Found and verified in clean containers by MrJev in [#6](https://github.com/jkudish/jev-browser/pull/6); `JEV_BROWSER_SKIP_BROWSER_DOWNLOAD=1` still skips the download.

## 0.4.0

- Recording support: `--record <path.webm|dir>` on the CLI and `recordDir` on `navigate()` capture a video of the page; results include `video_path` and per-step `t_ms` timestamps.
- OpenRouter typing default moved to `google/gemini-2.5-flash-lite`: `openai/gpt-5.6-luna` returns empty output through OpenRouter for short prompts (5/5 in testing), and the Gemini default is faster and cheaper than the alternatives measured.

## 0.3.0

- Cloudflare Workers AI support: with `CLOUDFLARE_API_TOKEN` (or `JEV_CLOUDFLARE_API_TOKEN`) and `CLOUDFLARE_ACCOUNT_ID` set, judgments run through Cloudflare at the `typesafe/jev` alias; `JEV_PROVIDER=cloudflare` forces it. Usage tokens are reported on every call.
- Vercel AI Gateway support: with `AI_GATEWAY_API_KEY` set, judgments run through the AI SDK evaluate API at `typesafe-ai/jev`; `JEV_PROVIDER=vercel` forces it. Noul, choice, and score answers are adapted back to this package's shapes, with TypeSafe confidence included.
- Provider resolution order: TypeSafe direct, OpenRouter, Cloudflare, Vercel.
- Internal fix: transport branches are explicitly guarded per provider.

## 0.2.0

- OpenRouter support: with only an `OPENROUTER_API_KEY`, Jev judgments route through OpenRouter's Decisions API (alpha), so one OpenRouter key can power the entire package, typing included. `JEV_PROVIDER` forces `typesafe` or `openrouter`; `jev-latest` maps to `typesafe/jev-1.13` on OpenRouter.
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
