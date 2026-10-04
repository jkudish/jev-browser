import type { JevTransport } from "@jkudish/jev-agent-tools";
import { openrouterSlug } from "./ladder.js";

const TITLE = "jev-browser";
const REFERER = "https://github.com/jkudish/jev-browser";

// Stock @jkudish/jev-agent-tools prefixes every bare name with typesafe/.
// This fork's ladder uses other OpenRouter decision ids, so a slash passes through.
export function openrouterDecisions(env: Record<string, string | undefined> = process.env): JevTransport {
  const key = env.OPENROUTER_API_KEY ?? "";
  if (!/^sk-or-/.test(key)) throw new Error("OPENROUTER_API_KEY is not set or not an sk-or- key.");
  return {
    name: "openrouter",
    async ask({ state, questions, model, signal }) {
      const slug = openrouterSlug(model);
      const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": REFERER,
          "X-Title": TITLE,
          "X-OpenRouter-Title": TITLE,
        },
        body: JSON.stringify({ model: slug, state, questions }),
        signal,
      }).catch(() => {
        if (signal.aborted) throw signal.reason;
        throw new Error("OpenRouter decisions API HTTP unavailable (network error; 0 response bytes)");
      });
      const raw = await response.text().catch(() => {
        if (signal.aborted) throw signal.reason;
        throw new Error(`OpenRouter decisions API HTTP ${response.status} (body read error; 0 response bytes)`);
      });
      const bytes = Buffer.byteLength(raw);
      if (!response.ok) {
        const error = new Error(`OpenRouter decisions API HTTP ${response.status} (request failed; ${bytes} response bytes)`);
        (error as Error & { status?: number }).status = response.status;
        throw error;
      }
      let body: { answers?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
      try {
        body = JSON.parse(raw);
      } catch {
        throw new Error(`OpenRouter decisions API HTTP ${response.status} (invalid JSON; ${bytes} response bytes)`);
      }
      const usage = body?.usage;
      return {
        answers: body.answers,
        usage: {
          input_tokens: usage && typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
          output_tokens: usage && typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        },
        model: slug,
      };
    },
  };
}
