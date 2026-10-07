// Environment for discern-browser 1.x. Every JEV_<X> variable is a legacy
// alias of DISCERN_<X> (normalizeDiscernEnv from discern-agent-tools owns the
// rule: DISCERN_ wins, a JEV_ name alone is copied over, two different
// non-empty values are a configuration error naming both variables and never
// their values). After normalization this package reads only DISCERN_ names.
// JEV_ names stop working in 2.0.
import { normalizeDiscernEnv } from "@jkudish/discern-agent-tools";

export type Env = Record<string, string | undefined>;

const warned = new Set<string>();

/**
 * Returns a normalized copy of `source` and prints one stderr deprecation line
 * per legacy variable, once per process. Never writes to stdout (the MCP
 * protocol stream and the CLI's JSON output) and never prints a value.
 */
export function discernEnv(source: Env = process.env): Env {
  const { env, legacy } = normalizeDiscernEnv(source);
  for (const name of legacy) {
    if (warned.has(name)) continue;
    warned.add(name);
    const current = `DISCERN_${name.slice("JEV_".length)}`;
    process.stderr.write(`[discern-browser] ${name} is deprecated; rename it to ${current}. JEV_ variables stop working in 2.0.\n`);
  }
  return env;
}

/**
 * Startup normalization for the MCP server and CLI: copies legacy values into
 * their DISCERN_ names in process.env, so every later reader (including code
 * paths outside navigate()) sees only DISCERN_ names. Throws on a conflict.
 */
export function applyDiscernEnv(): void {
  const env = discernEnv(process.env);
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("DISCERN_") && value !== undefined && process.env[name] !== value) process.env[name] = value;
  }
}

export type ToolNames = "discern" | "jev";

/** DISCERN_TOOL_NAMES selects which tool name tools/list advertises; both names stay callable. */
export function toolNamesFrom(env: Env): ToolNames {
  const raw = env.DISCERN_TOOL_NAMES?.trim().toLowerCase() || "discern";
  if (raw !== "discern" && raw !== "jev") throw new Error('DISCERN_TOOL_NAMES must be "discern" or "jev"');
  return raw;
}
