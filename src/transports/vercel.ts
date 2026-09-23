import { createGateway, experimental_evaluate } from "ai";
import type { BuiltinDriver } from "../provider.js";

// Internal factory seam: tests provide evaluate without replacing ESM exports.
export function createVercelDriver(evaluate: typeof experimental_evaluate = experimental_evaluate): BuiltinDriver {
  return {
    name: "vercel",
    isConfigured: (env) => Boolean(env.AI_GATEWAY_API_KEY),
    assertConfigured(env) {
      if (!this.isConfigured(env)) throw new Error("AI_GATEWAY_API_KEY is not set.");
    },
    create(env) {
      this.assertConfigured(env);
      const gateway = createGateway({ apiKey: env.AI_GATEWAY_API_KEY! });
      return {
        name: this.name,
        async ask({ state, questions, model, signal }) {
          const adaptedQuestions: Record<string, any> = {};
          for (const [id, question] of Object.entries(questions)) {
            const q = question as { type: string; instructions?: unknown; criteria?: unknown };
            adaptedQuestions[id] = { type: q.type === "noul" ? "boolean" : q.type, instructions: q.instructions, criteria: q.criteria };
          }
          const effective = model.startsWith("typesafe-ai/") ? model : "typesafe-ai/jev";
          let result: Awaited<ReturnType<typeof evaluate>>;
          try {
            result = await evaluate({ model: gateway.evaluation(effective), state: state as any, questions: adaptedQuestions as any, abortSignal: signal });
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            const status = (error as { statusCode?: unknown }).statusCode;
            throw new Error(`Vercel AI Gateway ${typeof status === "number" ? `HTTP ${status}` : "request failed"} (response omitted)`);
          }
          return {
            answers: adaptVercelAnswers(result.answers, result.providerMetadata),
            usage: { input_tokens: result.usage?.inputTokens ?? 0, output_tokens: result.usage?.outputTokens ?? 0 },
            model: effective,
          };
        },
      };
    },
  };
}

export function adaptVercelAnswers(answers: unknown, metadata: unknown): unknown {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return answers;
  const confidence = (metadata as any)?.typesafe?.confidence ?? {};
  const adapted: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries(answers)) {
    const value = answer as any;
    if (value?.type === "boolean") adapted[id] = { type: "noul", noul: value.probability };
    else if (value?.type === "choice") adapted[id] = { type: "choice", choice: value.choice, probabilities: value.probabilities, confidence: confidence[id] ?? null };
    else if (value?.type === "score") adapted[id] = { type: "score", score: value.score, probabilities: value.probabilities, confidence: confidence[id] ?? null };
    else adapted[id] = answer;
  }
  return adapted;
}

export const vercel = createVercelDriver();
