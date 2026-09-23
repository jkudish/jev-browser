import type { BuiltinDriver } from "../provider.js";

export const cloudflare: BuiltinDriver = {
  name: "cloudflare",
  isConfigured: (env) => Boolean((env.JEV_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN) && env.CLOUDFLARE_ACCOUNT_ID),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new Error("a Cloudflare API token (CLOUDFLARE_API_TOKEN or JEV_CLOUDFLARE_API_TOKEN) and CLOUDFLARE_ACCOUNT_ID are not both set.");
  },
  create(env) {
    this.assertConfigured(env);
    const token = env.JEV_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
    const account = env.CLOUDFLARE_ACCOUNT_ID!;
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        const slug = model.startsWith("typesafe/") ? model : `typesafe/${model === "jev-latest" ? "jev" : model}`;
        const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: slug, input: { state, questions } }),
          signal,
        }).catch(() => {
          if (signal.aborted) throw signal.reason;
          throw new Error("Cloudflare AI run HTTP unavailable (network error; 0 response bytes)");
        });
        const raw = await response.text().catch(() => {
          if (signal.aborted) throw signal.reason;
          throw new Error(`Cloudflare AI run HTTP ${response.status} (body read error; 0 response bytes)`);
        });
        const bytes = Buffer.byteLength(raw);
        if (!response.ok) throw new Error(`Cloudflare AI run HTTP ${response.status} (request failed; ${bytes} response bytes)`);
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          throw new Error(`Cloudflare AI run HTTP ${response.status} (invalid JSON; ${bytes} response bytes)`);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`Cloudflare AI run HTTP ${response.status} (invalid envelope; ${bytes} response bytes)`);
        if (body.success === false) throw new Error(`Cloudflare AI run HTTP ${response.status} (API unsuccessful; ${bytes} response bytes)`);
        // The v4 envelope double-nests the model output under result.result.
        const outer = body.result;
        if (outer && typeof outer.state === "string" && outer.state !== "Completed") {
          throw new Error(`Cloudflare AI run HTTP ${response.status} (non-Completed state; ${bytes} response bytes)`);
        }
        const payload = outer?.result ?? outer ?? body;
        const usage = payload?.usage;
        if (usage !== undefined && (typeof usage !== "object" || usage === null || Array.isArray(usage))) {
          throw new Error(`Cloudflare AI run HTTP ${response.status} (invalid usage; ${bytes} response bytes)`);
        }
        return {
          answers: payload?.answers,
          usage: {
            input_tokens: usage && Object.hasOwn(usage, "input_tokens") ? usage.input_tokens : 0,
            output_tokens: usage && Object.hasOwn(usage, "output_tokens") ? usage.output_tokens : 0,
          },
          model: payload?.model ?? slug,
        };
      },
    };
  },
};
