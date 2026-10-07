import { ask, resolveTransport } from "@jkudish/discern-agent-tools";
import type { DiscernAnswer, DiscernTransport, DiscernTransportInput, DiscernTransportReply } from "@jkudish/discern-agent-tools";

export { resolveTransport };
export type { DiscernAnswer, DiscernTransport, DiscernTransportInput, DiscernTransportReply };

/** @deprecated Use DiscernAnswer. Removed in 2.0. */
export type JevAnswer = DiscernAnswer;
/** @deprecated Use DiscernTransport. Removed in 2.0. */
export type JevTransport = DiscernTransport;
/** @deprecated Use DiscernTransportInput. Removed in 2.0. */
export type JevTransportInput = DiscernTransportInput;
/** @deprecated Use DiscernTransportReply. Removed in 2.0. */
export type JevTransportReply = DiscernTransportReply;

export interface AskResult {
  answers: Record<string, DiscernAnswer>;
  usage: DiscernTransportReply["usage"];
  provider: string;
  model: string;
}

/** Internal marker so a failed judgment cannot be mistaken for a page action error. */
export class InvalidJudgmentAnswer extends Error {}

export async function askJudgment(transport: DiscernTransport, input: DiscernTransportInput): Promise<AskResult> {
  const result = await ask(input, { transport });
  if (!result.ok) {
    if (input.signal.aborted) throw input.signal.reason;
    if (result.code === "request_failed") throw new Error(result.message);
    throw new InvalidJudgmentAnswer(result.message);
  }
  // The package redacts unrecognized names; successful injected transports
  // still report the caller's name, as the public navigate() API promises.
  const provider = typeof transport.name === "string" && transport.name.trim() ? transport.name : "unknown";
  return { answers: result.answer, usage: result.usage, provider, model: result.model };
}
