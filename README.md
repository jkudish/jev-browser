# Jev Browser

[![CI](https://github.com/jkudish/jev-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/jkudish/jev-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Fast and very cheap browser use using TypeSafe's Jev model.

Give jev-browser a task and a URL.

It drives a real headless browser through an MCP server, CLI, or library. TypeSafe's Jev model picks one action per step from the page's clickable, typeable, and selectable elements, and scores how likely it is that the goal is met or the run is stuck. Code owns the loop: budgets, recovery, stop gates. You get the final page, a step trace with confidences, console errors, and a screenshot.

Things it has done on real sites, not demos:

- Navigated Wikipedia from the Coffee article to Espresso in about 4 seconds, for $0.0016.
- Filled a contact form and stopped without submitting it.
- Pulled the price off a live pricing page.
- Returned a full guide page as markdown.
- Produced an accessibility-tree breakdown of a WordPress site.

This is early software. Expect rough edges on harder sites. Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Demo

Searches GitHub for this repository, opens Releases, and answers a question about the page. Every Jev judgment is on the right: the action chosen, its confidence, and the goal and stuck probabilities for each step.

![jev-browser searching GitHub and opening its own Releases page, judgment trace on the right](assets/github-demo.gif)

Full-resolution video: [assets/github-demo.mp4](assets/github-demo.mp4).

## Install

Requires Node.js 20 or newer, a TypeSafe API key from [console.typesafe.ai/settings/keys](https://console.typesafe.ai/settings/keys), and optionally a key for a typing provider (see [the typing model](#the-typing-model)). Playwright's Chromium downloads automatically on install; set `JEV_BROWSER_SKIP_BROWSER_DOWNLOAD=1` to opt out.

### Let an agent install it for you

Paste this into your coding agent:

```text
Install the Jev Browser MCP server for me. The package is @jkudish/jev-browser on npm and the server
command is `npx -y @jkudish/jev-browser`; register it as an MCP server with your client. Check whether
TYPESAFE_API_KEY is already set in the server environment; if not, walk me through setting it up without
pasting the key into the chat (I can create one at console.typesafe.ai/settings/keys). When it's
registered, ask if I'd like to run a first navigation task, and when we do, show me the step trace and cost.
Full instructions: https://github.com/jkudish/jev-browser#readme
```

From npm:

```bash
npx -y @jkudish/jev-browser --help
```

<details>
<summary>Amp</summary>

```bash
amp mcp add jev-browser -- npx -y @jkudish/jev-browser
```

</details>

<details>
<summary>Claude Code</summary>

```bash
claude mcp add jev-browser -- npx -y @jkudish/jev-browser
```

</details>

<details>
<summary>Codex (<code>~/.codex/config.toml</code>)</summary>

```toml
[mcp_servers.jev-browser]
command = "npx"
args = ["-y", "@jkudish/jev-browser"]
```

</details>

<details>
<summary>OpenCode (<code>opencode.json</code>)</summary>

```json
{
  "mcp": {
    "jev-browser": {
      "type": "local",
      "command": ["npx", "-y", "@jkudish/jev-browser"],
      "environment": { "TYPESAFE_API_KEY": "ts_..." }
    }
  }
}
```

</details>

<details>
<summary>Any other MCP client</summary>

```json
{
  "mcpServers": {
    "jev-browser": {
      "command": "npx",
      "args": ["-y", "@jkudish/jev-browser"],
      "env": { "TYPESAFE_API_KEY": "ts_..." }
    }
  }
}
```

</details>

Some MCP clients filter the environment before spawning servers, which silently drops `TYPESAFE_API_KEY`. If the server reports a missing key, pass it explicitly as shown above.

## Without MCP: CLI and library

The same agent runs from the command line. Result JSON is printed to stdout.

```bash
npx -y @jkudish/jev-browser run "Find the newest release and stop on it" https://github.com/jkudish/jev-browser/releases
```

CLI options include `--format`, `--max-chars`, `--max-steps`, `--max-seconds`, `--no-typing`, `--screenshot path.jpg`, and `--record path.webm` (or a directory for Playwright's raw output). Run with `--help` for the full list.

Or import it as a library. The package entry exports `navigate` side-effect free: importing it starts no server and no browser until you call it.

```js
import { navigate } from "@jkudish/jev-browser";

const result = await navigate({
  task: "Find the price of the Pro plan",
  startUrl: "https://example.com/pricing",
  format: "markdown",
  maxSteps: 16,
});

if ("error" in result) throw new Error(result.error);
console.log(result.status, result.final_url);
console.log(result.page.content);
```

## Password fill (logins)

The agent can fill native password fields without the password ever reaching a model. The value arrives through one of three channels, lives in memory for a single run, and is scrubbed from every state, trace, error, URL, and payload the run produces. Video recording is refused on credential runs and the final screenshot is suppressed once a fill is attempted. A fill never submits: no Enter, no click.

Set the trust anchor once, in the MCP server's environment:

```bash
JEV_BROWSER_PASSWORD_ORIGIN=https://acme.com
```

That must be an exact origin (scheme, host, port; no wildcards; http is allowed only on localhost). Fills happen only on that origin. Anywhere else the fill is refused and the refusal shows in the step trace as `origin_mismatch`.

Then pipe the secret in per run. Any producer that can print bytes works: 1Password, Bitwarden, `pass`, LastPass, the macOS Keychain, `secret-tool`, Vault, a plain file, or an environment variable you already have.

**MCP, via a one-shot handoff file.** The server only accepts files placed directly inside its handoff directory (default `~/.jev-browser/handoff`, mode 0700), validates them (owner, mode 0600, single link, no symlinks, sane size), and deletes them at run start:

```bash
mkdir -p ~/.jev-browser/handoff && chmod 700 ~/.jev-browser/handoff
pwfile="$HOME/.jev-browser/handoff/pw.$$"
op read --no-newline --out-file "$pwfile" 'op://Work/acme/password'
chmod 600 "$pwfile"
```

```jsonc
// arguments
{
  "task": "Log in and open the billing page",
  "start_url": "https://acme.com/login",
  "password_file": "/home/you/.jev-browser/handoff/pw.12345"
}
```

**MCP, via an environment variable.** Naming a variable `JEV_PASSWORD_*` is the opt-in. Any other name is rejected before its value is ever looked up, so the model cannot probe the server's environment:

```bash
# once, in the MCP server's environment:
JEV_PASSWORD_ACME="$(op read --no-newline 'op://Work/acme/password')"
```

```jsonc
// arguments
{
  "task": "Log in and open the billing page",
  "start_url": "https://acme.com/login",
  "password_env": "JEV_PASSWORD_ACME"
}
```

**CLI, straight from a pipe.** `-` reads the secret from stdin, so it never appears in argv, the environment, or process listings:

```bash
op read --no-newline 'op://Work/acme/password' |
  npx -y @jkudish/jev-browser run "Log in and open the billing page" \
    https://acme.com/login --password-file - --password-origin https://acme.com
```

Rules and limits of the mechanism, stated plainly:

- `password_file` takes a local pathname only. Never put the password value in the task, in tool arguments, in argv, or in the filename.
- Library callers pass `password: { value, origin }` in the `navigate()` options instead; the same validation, origin binding, and redaction apply.
- Handoff files are one-shot: read and unlinked at run start. Recreate the file for every run.
- The mechanism needs the agent's shell and the MCP server to share a filesystem. It does not protect against a host agent that reads the file itself or runs your secret manager without redirection; treat the `op read` command as operator-approved.
- The trusted origin can read and transmit the password, and its pages can submit from an input event with no Enter key. Origin binding does not make a compromised site safe.
- Redaction is defense in depth: raw, percent-encoded, form-encoded, HTML-encoded, markdown-escaped, whitespace-normalized, and YAML-escaped (aria snapshots) echoes of the value are scrubbed from everything the run returns, including values a page reflects into its own labels, attributes, console output, or URLs after the fill. On credential runs every capture window (labels, options, hrefs, excerpts, error strings) is sized to the longest known representation of the value, so an echo is always captured whole and redacted before any length cap can cut it; dropdowns are selected by DOM index, never by a label string; the task itself is scrubbed before any model sees it, so "the model never sees the value" holds even if a caller ignores this advice and puts it in the task. Secrets containing a line break or any control character, or whose echo-normalized form (whitespace collapsed, zero-width characters stripped) collapses below the safe redaction length, are rejected up front (produce it with `op read --no-newline` or equivalent). Redaction cannot cover arbitrary transformations, process-memory inspection, or OS-level monitoring. For the same reason, credential runs refuse any Playwright debug output (`PWDEBUG`, any nonempty `DEBUG`, `DEBUG_FILE`) and video recording.
- On runs without a password source, password inputs are skipped during extraction entirely: the feature costs nothing when unused.
- Every password field the model fills in a run receives the same configured value; this is for logging in, not for setting new passwords. `allow_typing: false` disables the feature entirely.

## The tool

Every run makes paid TypeSafe API calls, typically a fraction of a cent, plus one small LLM call per typed field when a typing provider is configured. The example below is a real run.

```jsonc
// arguments
{
  "task": "Search Wikipedia for the espresso-based drink called Ristretto and stop when you are on that article",
  "start_url": "https://en.wikipedia.org/wiki/Main_Page"
}
```

```jsonc
// live result, abridged
{
  "status": "done",
  "final_url": "https://en.wikipedia.org/wiki/Ristretto",
  "elapsed_ms": 5894,
  "steps": [
    { "step": 1, "proposed_action": "click_e2", "executed_action": "click_e2", "detail": "a \"Search Wikipedia [f]\" -> /wiki/Special:Search", "confidence": 1.0 },
    { "step": 2, "proposed_action": "type_e1", "executed_action": "type_e1", "detail": "typed \"Ristretto\" via openrouter", "confidence": 0.99 },
    { "step": 3, "proposed_action": "done", "executed_action": null, "detail": "done proposed; not executed", "confidence": 1.0 }
  ],
  "usage": { "jev_calls": 3, "input_tokens": 45810, "est_cost_usd": 0.0021 }
}
```

Parameters: `max_steps` (default 24), `max_seconds` (default 180), `allow_typing` (default true), `format` (`text`, `markdown`, `html`, `aria`), `max_chars` (override the cap), `screenshot` (`final`, default, or `none`).

## What you get back

**The final page, in the format you ask for.** Every payload reports `truncated` and `true_length`, and `max_chars` overrides any default.

| Format | Default cap | Best for |
| --- | --- | --- |
| `text` | 8,000 chars | Feeding the page to Jev or an LLM next; quick reads |
| `markdown` | 16,000 chars | Readable artifacts and notes; carries navigation chrome |
| `html` | 1 MB | Parsing the page yourself with your own selectors |
| `aria` | 16,000 chars | The accessibility tree as YAML; what screen readers and agents see |

**A final screenshot.** A viewport JPEG that renders inline in MCP clients, or lands as a file with the CLI's `--screenshot path.jpg`. Pass `screenshot: "none"` to skip it.

**A debug trace you can audit.** One record per step: the proposed action versus the action actually executed, why a recovery fired, action errors, the Choice confidence, the top option's probability, and the goal and stuck probabilities for that step. Stop statuses say which gate fired. Alongside the trace: console errors, page errors, and failed network requests captured per step and tagged with the page they came from, up to 200 events, plus Jev call counts, token usage, and estimated cost. If the final payload or screenshot could not be extracted, the run still returns and lists the problem under `extraction_problems`.

## How it decides

Each step makes one primary Jev call with three questions over the same state: an action Choice over the page's interactive elements plus scroll/back/done, a goal Noul, and a stuck Noul ([fan-out pattern](https://docs.typesafe.ai/patterns/fan-out.md)). The state includes a short excerpt of the page's visible text, so the goal judgment can see content, not just URLs and links. A select action adds one second-stage Choice for its option. Elements come from the DOM directly, not the accessibility tree, because accessibility trees under-report inputs; the agent found DuckDuckGo's search box only after this switch. Actions: click, type, select a native dropdown, scroll, back, done.

Stop conditions, in code, checked before executing the step's proposed action: the agent chooses `done`, goal probability > 0.85, stuck probability > 0.85, the step budget, or the time budget. A repeated action with no effect switches to the next-best option from the Choice distribution. There is deliberately no low-confidence override: split probability across several similar elements is usually several acceptable alternatives, not uncertainty.

Statuses: `done` (agent chose to stop), `goal_achieved` (the goal watcher fired), `stuck`, `max_steps`, `timeout`, `error`. `done` and `goal_achieved` are two independent judgments; agreement between them is what a trustworthy finish looks like, and the trace shows both at every step.

## The typing model

Jev never generates text. It returns typed decisions only: which option, with what probabilities. So when a task needs a string, typing a search query or filling a field, that string comes from a small model you choose. This is the only place a second model is involved, and it runs at most once or twice per task, about 48 tokens per call.

Configuration is automatic when possible. The server picks the first provider whose key it recognizes, in this order:

| Provider | Recognized by | Default model |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` starting with `sk-` | `gpt-5.6-luna` |
| OpenRouter | `OPENROUTER_API_KEY` starting with `sk-or-` | `openai/gpt-5.6-luna` |
| Anthropic | `ANTHROPIC_API_KEY` starting with `sk-ant-` | `claude-haiku-4.5` |
| Google | `GEMINI_API_KEY` or `GOOGLE_GENERATIVE_AI_API_KEY` starting with `AIza` | `gemini-2.5-flash` |

Overrides:

- `JEV_BROWSER_TYPE_MODEL` picks any model the resolved provider offers, for example `openrouter:anthropic/claude-haiku-4.5` style ids.
- `JEV_BROWSER_TYPE_PROVIDER` forces one of `openai`, `openrouter`, `anthropic`, `google`, skipping auto-detection.
- `JEV_BROWSER_TYPE_BASE_URL` (plus `JEV_BROWSER_TYPE_API_KEY` if it needs one) points at any OpenAI-compatible endpoint: Ollama, LM Studio, vLLM, a gateway. This wins over provider detection.

Local example, no cloud key at all:

```bash
JEV_BROWSER_TYPE_BASE_URL=http://localhost:11434/v1 JEV_BROWSER_TYPE_MODEL=qwen2.5:7b \
  npx -y @jkudish/jev-browser run "Search Wikipedia for Ristretto and stop on the article" https://en.wikipedia.org/wiki/Main_Page
```

With no provider at all, typing falls back to a keyword heuristic built from the task text. It is labeled honestly in the trace (`via keyword-heuristic`), and it is meaningfully worse: in testing its queries buried a target article eight results pages deep. Give it a real model if your tasks type anything.

## Limits

- Up to 240 elements per step; Jev's Choice supports 255 options. Beyond that the list is truncated and the state says so, which can hide the needed element on very dense pages.
- The markdown format converts the whole body, so it carries navigation chrome and can include inline script text; a readability pass is a candidate improvement, not a committed one.
- Password fields are only ever filled by code, never typed by the model, and only when a password source is configured (see [Password fill](#password-fill-logins)); file inputs are never offered. Hover-revealed menus, keyboard actions (Escape, Enter on unstaged fields), multi-field form sequencing, shadow DOM, and iframes are out of scope for v0.1.
- Thresholds (0.85 goal, 0.85 stuck, budgets) are starting points measured on Wikipedia and DuckDuckGo tasks. Tune them for your sites.
- Jev is calibrated, not infallible. Treat the trace as evidence, not proof.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | none | TypeSafe direct. Default provider when set. |
| `OPENROUTER_API_KEY` | none | Powers both the Jev judgments (when `TYPESAFE_API_KEY` is absent) and, optionally, the typing model. One key runs everything. |
| `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | none | Cloudflare Workers AI for the Jev judgments; used when no other provider key is present. |
| `JEV_PROVIDER` | `auto` | Force `typesafe`, `openrouter`, `cloudflare`, or `vercel` for the Jev calls instead of auto-detection. |
| `JEV_BROWSER_MODEL` | `jev-latest` | Pin a Jev version, or `typesafe/jev-1.13` on OpenRouter. |
| `JEV_BROWSER_TYPE_*` | see above | Typing provider, model, and endpoint. |
| `JEV_BROWSER_HEADED` | unset | Set to `1` to watch the browser. |
| `JEV_BROWSER_SKIP_BROWSER_DOWNLOAD` | unset | Set to `1` to skip the Chromium postinstall. |
| `JEV_BROWSER_PASSWORD_ORIGIN` | unset | Required for password fill: the exact origin password fields may be filled on. |
| `JEV_BROWSER_HANDOFF_DIR` | `~/.jev-browser/handoff` | Directory password handoff files must live in (0700). |

### Vercel

With `AI_GATEWAY_API_KEY` set, judgments run through the Vercel AI Gateway at `typesafe-ai/jev`, using the AI SDK's evaluate API. Answers are adapted back to this package's shapes, including TypeSafe's confidence statistic. Gateway calls appear in Vercel logs and budgets.

### Cloudflare

With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set (and no other provider key), judgments run through Cloudflare Workers AI at `typesafe/jev`, the single always-current alias. Usage tokens come back on every call. Cloudflare serves one alias rather than pinned versions, and pricing is listed in the Cloudflare dashboard. Direct TypeSafe remains the recommended default when you have several keys.

### OpenRouter

With only an `OPENROUTER_API_KEY`, both the Jev judgments and (with no other typing provider) the typing model run through OpenRouter: one key powers the whole package. The Jev endpoint there is alpha and adds a hop, and it serves pinned versions rather than a `latest` alias, so `jev-latest` maps to `typesafe/jev-1.13`. Direct TypeSafe remains the recommended default when you have both keys.

## Also in the family

Need the judgments without the browser? [Jev MCP](https://github.com/jkudish/jev-mcp) exposes the same model as eight judgment tools your agent can call anywhere: verify claims against evidence, screen content before it enters context, find and rerank by meaning, batch-classify, decide, compare passages, and extract fields. The npm package is [@jkudish/jev-mcp](https://www.npmjs.com/package/@jkudish/jev-mcp).

## Sponsoring

If you find Jev Browser useful, consider becoming a [sponsor](https://github.com/sponsors/jkudish) or [donating](https://stripe.com/@jkudish).

## Development

```bash
npm install
npm run build
npm test            # unit tests, offline
npm run test:e2e    # live navigation tests; requires TYPESAFE_API_KEY
```

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
