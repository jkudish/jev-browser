import { typesafe } from "./transports/typesafe.js";
import { openrouter } from "./transports/openrouter.js";
import { cloudflare } from "./transports/cloudflare.js";
import { vercel } from "./transports/vercel.js";

export interface JevTransportInput {
  state: unknown;
  questions: Record<string, unknown>;
  model: string;
  signal: AbortSignal;
}

export interface JevTransportReply {
  answers: unknown;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

export interface JevTransport {
  readonly name: string;
  ask(input: JevTransportInput): Promise<JevTransportReply>;
}

export interface BuiltinDriver {
  readonly name: "typesafe" | "openrouter" | "cloudflare" | "vercel";
  isConfigured(env: NodeJS.ProcessEnv): boolean;
  assertConfigured(env: NodeJS.ProcessEnv): void;
  create(env: NodeJS.ProcessEnv): JevTransport;
}

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number | null }
  | { type: "score"; score: number; probabilities: Record<string, number>; confidence: number | null };

export interface AskResult {
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
  provider: string;
  model: string;
}

/** Internal marker so a failed judgment cannot be mistaken for a page action error. */
export class InvalidJevAnswer extends Error {}

const drivers: readonly BuiltinDriver[] = [typesafe, openrouter, cloudflare, vercel];

export function resolveTransport(env: NodeJS.ProcessEnv = process.env): JevTransport {
  const explicit = (env.JEV_PROVIDER ?? "auto").toLowerCase();
  if (explicit !== "auto") {
    const driver = drivers.find((candidate) => candidate.name === explicit);
    if (!driver) throw new Error("Unknown JEV_PROVIDER; choose typesafe, openrouter, cloudflare, vercel, or auto.");
    try {
      driver.assertConfigured(env);
    } catch (error) {
      throw new Error(`JEV_PROVIDER=${driver.name} but ${(error as Error).message}`);
    }
    return driver.create(env);
  }
  const driver = drivers.find((candidate) => candidate.isConfigured(env));
  if (!driver) {
    throw new Error("No TYPESAFE_API_KEY, OPENROUTER_API_KEY (sk-or-), Cloudflare token (CLOUDFLARE_API_TOKEN or JEV_CLOUDFLARE_API_TOKEN) + CLOUDFLARE_ACCOUNT_ID, or AI_GATEWAY_API_KEY found. Set one, or JEV_PROVIDER to choose explicitly.");
  }
  return driver.create(env);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function distribution(value: unknown, keys: string[], fail: (reason: string) => never): Record<string, number> {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail("distribution must contain exactly the criteria keys");
  }
  let sum = 0;
  const probabilities: Record<string, number> = {};
  for (const key of keys) {
    const probability = value[key];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      fail("distribution must contain finite probabilities in [0,1]");
    }
    probabilities[key] = probability as number;
    sum += probability as number;
  }
  // Upstream distributions are rounded; permit a one-percent sum drift and
  // a 0.001 selection tie, but not a different winner.
  if (Math.abs(sum - 1) > 0.01) fail("distribution must sum to approximately 1");
  return probabilities;
}

export async function askJev(transport: JevTransport, input: JevTransportInput): Promise<AskResult> {
  // The label is caller-supplied for injected transports, not a wire field.
  const provider = typeof transport.name === "string" && transport.name.trim() ? transport.name : "unknown";
  const fail = (id: string, reason: string): never => {
    throw new InvalidJevAnswer(`Jev provider ${provider} question ${id}: ${reason}`);
  };
  const reply = await transport.ask(input);
  if (!record(reply) || !record(reply.answers)) fail("<response>", "answers must be an object");
  const answers = reply.answers as Record<string, unknown>;
  const ids = Object.keys(input.questions);
  for (const id of ids) if (!Object.hasOwn(answers, id)) fail(id, "missing answer");
  if (Object.keys(answers).length !== ids.length) fail("<response>", "unexpected answer ID");
  const validated: Record<string, JevAnswer> = {};
  for (const id of ids) {
    const question = input.questions[id];
    const answer = answers[id];
    const invalid = (reason: string): never => fail(id, reason);
    if (!record(question) || !record(answer) || answer.type !== question.type) throw new InvalidJevAnswer(`Jev provider ${provider} question ${id}: missing answer or wrong type`);
    if (question.type === "noul") {
      if (typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) invalid("noul must be finite in [0,1]");
      validated[id] = { type: "noul", noul: answer.noul as number };
      continue;
    }
    const keys = question.type === "score" && Array.isArray(question.criteria)
      ? question.criteria.map((_, index) => String(index))
      : question.type === "choice" && record(question.criteria) ? Object.keys(question.criteria) : null;
    if (!keys?.length) invalid("invalid question criteria");
    const probabilities = distribution(answer.probabilities, keys!, invalid);
    const confidence = answer.confidence === undefined ? null : answer.confidence;
    if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence))) invalid("confidence must be finite or null");
    if (question.type === "choice") {
      if (typeof answer.choice !== "string" || !keys!.includes(answer.choice)) invalid("choice is outside criteria");
      if (probabilities[answer.choice as string] + 0.001 < Math.max(...Object.values(probabilities))) invalid("choice is not a distribution maximum");
      validated[id] = { type: "choice", choice: answer.choice as string, probabilities, confidence: confidence as number | null };
    } else if (question.type === "score") {
      if (typeof answer.score !== "number" || !Number.isInteger(answer.score) || !keys!.includes(String(answer.score))) invalid("score is outside criteria levels");
      validated[id] = { type: "score", score: answer.score as number, probabilities, confidence: confidence as number | null };
    } else invalid("unsupported question type");
  }
  if (!record(reply.usage) || !Number.isSafeInteger(reply.usage.input_tokens) || (reply.usage.input_tokens as number) < 0 || !Number.isSafeInteger(reply.usage.output_tokens) || (reply.usage.output_tokens as number) < 0) {
    fail("<response>", "usage counters must be non-negative safe integers");
  }
  if (typeof reply.model !== "string" || !reply.model.trim()) fail("<response>", "effective model must be nonempty");
  return { answers: validated, usage: reply.usage as AskResult["usage"], provider, model: reply.model as string };
}
