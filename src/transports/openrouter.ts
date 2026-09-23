import type { BuiltinDriver } from "../provider.js";

const TITLE = "jev-browser";
const REFERER = "https://github.com/jkudish/jev-browser";

export const openrouter: BuiltinDriver = {
  name: "openrouter",
  isConfigured: (env) => /^sk-or-/.test(env.OPENROUTER_API_KEY ?? ""),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new Error("OPENROUTER_API_KEY is not set or not an sk-or- key.");
  },
  create(env) {
    this.assertConfigured(env);
    const key = env.OPENROUTER_API_KEY!;
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        const effective = model === "jev-latest" ? "jev-1.13" : model;
        const slug = effective.startsWith("typesafe/") ? effective : `typesafe/${effective}`;
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
        if (!response.ok) throw new Error(`OpenRouter decisions API HTTP ${response.status} (request failed; ${bytes} response bytes)`);
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new Error(`OpenRouter decisions API HTTP ${response.status} (invalid JSON; ${bytes} response bytes)`);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`OpenRouter decisions API HTTP ${response.status} (invalid envelope; ${bytes} response bytes)`);
        const usage = body.usage;
        if (usage !== undefined && (typeof usage !== "object" || usage === null || Array.isArray(usage))) {
          throw new Error(`OpenRouter decisions API HTTP ${response.status} (invalid usage; ${bytes} response bytes)`);
        }
        return {
          answers: body.answers,
          // The decisions endpoint does not document usage; absence means zero.
          usage: {
            input_tokens: usage && Object.hasOwn(usage, "input_tokens") ? usage.input_tokens : 0,
            output_tokens: usage && Object.hasOwn(usage, "output_tokens") ? usage.output_tokens : 0,
          },
          model: slug,
        };
      },
    };
  },
};
