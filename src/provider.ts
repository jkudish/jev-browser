// Jev transport: TypeSafe direct (default), OpenRouter Decisions, Requesty
// (chat/completions with a "questions" response_format), or
// Cloudflare Workers AI. All speak the {state, questions} / answers contract;
// URL, auth, and model slugs differ. Proxies add hops, so direct TypeSafe
// remains the recommended default.

import { experimental_evaluate } from "ai";
import { TypeSafeClient } from "@typesafe-ai/sdk";

export type JevProvider = "typesafe" | "openrouter" | "requesty" | "cloudflare" | "vercel";

export interface AskResult {
  answers: Record<string, any>;
  usage: { input_tokens: number; output_tokens: number };
  provider: JevProvider;
  model: string;
}

const X_TITLE = "jev-browser";
const REFERER = "https://github.com/jkudish/jev-browser";

let typesafeClient: TypeSafeClient | null = null;

function resolve(env: NodeJS.ProcessEnv): JevProvider {
  const explicit = (env.JEV_PROVIDER ?? "auto").toLowerCase();
  const hasTypesafe = Boolean(env.TYPESAFE_API_KEY);
  const hasOpenRouter = /^sk-or-/.test(env.OPENROUTER_API_KEY ?? "");
  const hasRequesty = Boolean(env.REQUESTY_API_KEY);
  const cfToken = env.JEV_CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const hasCloudflare = Boolean(cfToken && env.CLOUDFLARE_ACCOUNT_ID);

  if (explicit === "typesafe") {
    if (!hasTypesafe) throw new Error("JEV_PROVIDER=typesafe but TYPESAFE_API_KEY is not set.");
    return "typesafe";
  }
  if (explicit === "openrouter") {
    if (!hasOpenRouter) throw new Error("JEV_PROVIDER=openrouter but OPENROUTER_API_KEY is not set or not an sk-or- key.");
    return "openrouter";
  }
  if (explicit === "requesty") {
    if (!hasRequesty) throw new Error("JEV_PROVIDER=requesty but REQUESTY_API_KEY is not set.");
    return "requesty";
  }
  if (explicit === "vercel") {
    if (!env.AI_GATEWAY_API_KEY) throw new Error("JEV_PROVIDER=vercel but AI_GATEWAY_API_KEY is not set.");
    return "vercel";
  }
  if (explicit === "cloudflare") {
    if (!hasCloudflare) throw new Error("JEV_PROVIDER=cloudflare but a Cloudflare API token (CLOUDFLARE_API_TOKEN or JEV_CLOUDFLARE_API_TOKEN) and CLOUDFLARE_ACCOUNT_ID are not both set.");
    return "cloudflare";
  }
  if (hasTypesafe) return "typesafe";
  if (hasOpenRouter) return "openrouter";
  if (hasRequesty) return "requesty";
  if (hasCloudflare) return "cloudflare";
  if (env.AI_GATEWAY_API_KEY) return "vercel";
  throw new Error(
    "No TYPESAFE_API_KEY, OPENROUTER_API_KEY (sk-or-), REQUESTY_API_KEY, or Cloudflare token + CLOUDFLARE_ACCOUNT_ID found. Set one, or JEV_PROVIDER to choose explicitly.",
  );
}

/**
 * Requesty returns the typed answers inside the assistant message. TypeSafe's
 * own shapes pass straight through; a flattened or boolean-style answer is
 * lifted back into the shape the agent reads (`noul` as a probability,
 * `choice` with its distribution). Anything unrecognized is handed on
 * untouched so a contract change surfaces as a clear error upstream rather
 * than as a silently wrong decision.
 */
export function normalizeJevAnswers(
  raw: Record<string, any>,
  questions: Record<string, unknown>,
): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [id, answer] of Object.entries(raw ?? {})) {
    const kind = (questions[id] as { type?: string } | undefined)?.type;
    if (answer !== null && typeof answer === "object") {
      if (typeof answer.noul === "number" || typeof answer.choice === "string" || typeof answer.score === "string") {
        out[id] = answer;
        continue;
      }
      // Boolean-style: { type: "boolean", probability: 0.91 }
      if (typeof answer.probability === "number") {
        out[id] = { type: "noul", noul: answer.probability };
        continue;
      }
      out[id] = answer;
      continue;
    }
    if (kind === "noul" && typeof answer === "number") {
      out[id] = { type: "noul", noul: answer };
      continue;
    }
    if (kind === "noul" && typeof answer === "boolean") {
      out[id] = { type: "noul", noul: answer ? 1 : 0 };
      continue;
    }
    if (kind === "choice" && typeof answer === "string") {
      out[id] = { type: "choice", choice: answer, probabilities: {}, confidence: null };
      continue;
    }
    if (kind === "score" && typeof answer === "string") {
      out[id] = { type: "score", score: answer, probabilities: {}, confidence: null };
      continue;
    }
    out[id] = answer;
  }
  return out;
}

export async function askJev(
  state: unknown,
  questions: Record<string, unknown>,
  model: string,
  signal?: AbortSignal,
): Promise<AskResult> {
  const provider = resolve(process.env);

  if (provider === "typesafe") {
    typesafeClient ??= new TypeSafeClient(
      process.env.TYPESAFE_BASE_URL ? { baseURL: process.env.TYPESAFE_BASE_URL } : undefined,
    );
    const response = await (
      typesafeClient.systemOne as unknown as (
        payload: { state: unknown; questions: Record<string, unknown>; model?: string },
        options?: { signal?: AbortSignal },
      ) => Promise<any>
    )({ state, questions, model }, { signal });
    return {
      answers: response.answers,
      usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: response.usage?.output_tokens ?? 0 },
      provider,
      model,
    };
  }

  if (provider === "openrouter") {
    // OpenRouter has no redirecting "latest" slug; map it to the current
    // release. Pin exact versions with the model env var when that matters.
    const OPENROUTER_LATEST = "jev-1.13";
    const effective = model === "jev-latest" ? OPENROUTER_LATEST : model;
    const slug = effective.startsWith("typesafe/") ? effective : `typesafe/${effective}`;
    const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": REFERER,
        "X-Title": X_TITLE,
        "X-OpenRouter-Title": X_TITLE,
      },
      body: JSON.stringify({ model: slug, state, questions }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OpenRouter decisions API ${response.status}: ${body.slice(0, 200)}`);
    }
    const body = await response.json();
    return {
      answers: body.answers ?? {},
      // The decisions endpoint does not document a usage block; tolerate absence.
      usage: { input_tokens: body.usage?.input_tokens ?? 0, output_tokens: body.usage?.output_tokens ?? 0 },
      provider,
      model: slug,
    };
  }

  if (provider === "requesty") {
    // Requesty carries Jev over the OpenAI chat-completions shape rather than
    // a decisions endpoint: the state rides in one text user message, the
    // typed questions go in a `questions` response_format, and the assistant
    // message content is the answers JSON. Requesty documents this route as
    // experimental, so the response is validated rather than trusted.
    const REQUESTY_LATEST = "typesafe/jev-1.13.0";
    const slug =
      model === "jev-latest" ? REQUESTY_LATEST : model.startsWith("typesafe/") ? model : `typesafe/${model}`;
    const baseURL = (process.env.REQUESTY_BASE_URL ?? "https://router.requesty.ai/v1").replace(/\/+$/, "");
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.REQUESTY_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": REFERER,
        "X-Title": X_TITLE,
      },
      body: JSON.stringify({
        model: slug,
        // Text-only user message: Requesty rejects structured content here.
        messages: [{ role: "user", content: typeof state === "string" ? state : JSON.stringify(state) }],
        response_format: { type: "questions", questions },
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Requesty chat/completions ${response.status}: ${body.slice(0, 200)}`);
    }
    const body = await response.json();
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error(
        `Requesty returned no answer content (finish_reason ${body.choices?.[0]?.finish_reason ?? "unknown"}).`,
      );
    }
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new Error(`Requesty answer content is not JSON: ${content.slice(0, 200)}`);
    }
    return {
      answers: normalizeJevAnswers(parsed?.answers ?? parsed, questions),
      usage: {
        input_tokens: body.usage?.prompt_tokens ?? body.usage?.input_tokens ?? 0,
        output_tokens: body.usage?.completion_tokens ?? body.usage?.output_tokens ?? 0,
      },
      provider,
      model: slug,
    };
  }

  if (provider === "vercel") {
  // Vercel AI Gateway exposes Jev through the AI SDK's experimental evaluate
  // API: "noul" questions become "boolean", answers return as probabilities,
  // and Choice/Score confidence lives in providerMetadata.typesafe.
  const vercelQuestions: Record<string, any> = {};
  for (const [id, question] of Object.entries(questions)) {
    const q = question as { type: string; instructions?: unknown; criteria?: unknown };
    vercelQuestions[id] = {
      type: q.type === "noul" ? "boolean" : q.type,
      instructions: q.instructions,
      criteria: q.criteria,
    };
  }
  const result = await experimental_evaluate({
    model: model.startsWith("typesafe-ai/") ? model : "typesafe-ai/jev",
    state: state as any,
    questions: vercelQuestions as any,
    abortSignal: signal,
  });
  const confidence = ((result as any).providerMetadata?.typesafe?.confidence ?? {}) as Record<string, number>;
  const adapted: Record<string, any> = {};
  for (const [id, answer] of Object.entries(result.answers as Record<string, any>)) {
    if (answer?.type === "boolean") {
      adapted[id] = { type: "noul", noul: answer.probability };
    } else if (answer?.type === "choice") {
      adapted[id] = { type: "choice", choice: answer.choice, probabilities: answer.probabilities ?? {}, confidence: confidence[id] ?? null };
    } else if (answer?.type === "score") {
      adapted[id] = { type: "score", score: answer.score, probabilities: answer.probabilities ?? {}, confidence: confidence[id] ?? null };
    } else {
      adapted[id] = answer;
    }
  }
  return {
    answers: adapted,
    usage: { input_tokens: result.usage?.inputTokens ?? 0, output_tokens: result.usage?.outputTokens ?? 0 },
    provider,
    model: "typesafe-ai/jev",
  };
}

  // Cloudflare Workers AI wraps the same contract in {model, input} and the
  // v4 {result, success} envelope. Single alias; no version pinning.
  const cfSlug = model.startsWith("typesafe/") ? model : `typesafe/${model === "jev-latest" ? "jev" : model}`;
  const cfResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.JEV_CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfSlug, input: { state, questions } }),
      signal,
    },
  );
  const cfBody = await cfResponse.json().catch(() => ({}));
  if (!cfResponse.ok || cfBody.success === false) {
    throw new Error(`Cloudflare AI run ${cfResponse.status}: ${JSON.stringify(cfBody.errors ?? cfBody).slice(0, 200)}`);
  }
  // The v4 envelope double-nests: body.result.result holds the model output.
  const cfOuter = cfBody.result;
  if (cfOuter && typeof cfOuter.state === "string" && cfOuter.state !== "Completed") {
    throw new Error(`Cloudflare AI run state ${cfOuter.state}: ${JSON.stringify(cfBody.errors ?? []).slice(0, 200)}`);
  }
  const cfPayload = cfOuter?.result ?? cfOuter ?? cfBody;
  return {
    answers: cfPayload.answers ?? {},
    usage: { input_tokens: cfPayload.usage?.input_tokens ?? 0, output_tokens: cfPayload.usage?.output_tokens ?? 0 },
    provider,
    model: cfPayload.model ?? cfSlug,
  };
}
