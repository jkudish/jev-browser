import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { BuiltinDriver } from "../provider.js";

export const typesafe: BuiltinDriver = {
  name: "typesafe",
  isConfigured: (env) => Boolean(env.TYPESAFE_API_KEY),
  assertConfigured(env) {
    if (!this.isConfigured(env)) throw new Error("TYPESAFE_API_KEY is not set.");
  },
  create(env) {
    this.assertConfigured(env);
    const client = new TypeSafeClient({
      apiKey: env.TYPESAFE_API_KEY!,
      baseURL: env.TYPESAFE_BASE_URL || "https://api.typesafe.ai",
    });
    return {
      name: this.name,
      async ask({ state, questions, model, signal }) {
        let response: { answers: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
        try {
          response = await (
            client.systemOne as unknown as (
              payload: { state: unknown; questions: Record<string, unknown>; model: string },
              options: { signal: AbortSignal },
            ) => Promise<typeof response>
          )({ state, questions, model }, { signal });
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          const status = (error as { status?: unknown }).status;
          throw new Error(`TypeSafe API ${typeof status === "number" ? `HTTP ${status}` : "request failed"} (response omitted)`);
        }
        return {
          answers: response.answers,
          usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 },
          model,
        };
      },
    };
  },
};
