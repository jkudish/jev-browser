import { ask, type JevAnswer, type JevTransport } from "@jkudish/jev-agent-tools";
import { confidentEnough, confidenceFloor, modelLadder, shouldFallthrough } from "./ladder.js";

export interface TriedModel {
  model: string;
  confidence: number | null;
  error?: string;
}

export interface LadderHit {
  answers: Record<string, JevAnswer> | null;
  model: string | null;
  confidence: number | null;
  tried: TriedModel[];
  confident: boolean;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

function choiceConfidence(answers: Record<string, JevAnswer>): number | null {
  for (const answer of Object.values(answers)) {
    if (answer.type === "choice") return answer.confidence;
  }
  return 1;
}

// ponytail: process-level strike memory, reset on restart
const strikes = new Map<string, number>();
const STRIKE_LIMIT = 2;
const GARBAGE_CONFIDENCE = 0.1;

function recordResult(model: string, ok: boolean, confidence: number | null) {
  if (!ok || (confidence !== null && confidence < GARBAGE_CONFIDENCE)) {
    strikes.set(model, (strikes.get(model) ?? 0) + 1);
  } else {
    strikes.delete(model);
  }
}

function shouldSkip(model: string): boolean {
  return (strikes.get(model) ?? 0) >= STRIKE_LIMIT;
}

export async function askLadder(
  transport: JevTransport,
  state: unknown,
  questions: Record<string, unknown>,
  signal: AbortSignal,
  env: Record<string, string | undefined> = process.env,
): Promise<LadderHit> {
  const floor = confidenceFloor(env);
  const tried: TriedModel[] = [];
  let best: { answers: Record<string, JevAnswer>; model: string; confidence: number } | null = null;
  let calls = 0;
  let input_tokens = 0;
  let output_tokens = 0;
  let lastError = "no decision model answered";

  for (const model of modelLadder(env)) {
    if (shouldSkip(model)) {
      tried.push({ model, confidence: null, error: "skipped (circuit breaker)" });
      continue;
    }
    if (signal.aborted) throw signal.reason;
    const result = await ask({ state, questions, model, signal }, { transport });
    if (!result.ok) {
      if (signal.aborted) throw signal.reason;
      if (!shouldFallthrough(result.code, result.message)) throw new Error(result.message);
      recordResult(model, false, null);
      tried.push({ model, confidence: null, error: result.code });
      lastError = result.message;
      continue;
    }
    calls += 1;
    input_tokens += result.usage.input_tokens;
    output_tokens += result.usage.output_tokens;
    const confidence = choiceConfidence(result.answer);
    recordResult(model, true, confidence);
    tried.push({ model, confidence });
    const score = confidence ?? 0;
    if (!best || score > best.confidence) best = { answers: result.answer, model: result.model, confidence: score };
    if (confidentEnough(confidence, floor)) {
      return {
        answers: result.answer,
        model: result.model,
        confidence,
        tried,
        confident: true,
        calls,
        input_tokens,
        output_tokens,
      };
    }
  }

  if (!best) throw new Error(lastError);
  return {
    answers: best.answers,
    model: best.model,
    confidence: best.confidence,
    tried,
    confident: false,
    calls,
    input_tokens,
    output_tokens,
  };
}
