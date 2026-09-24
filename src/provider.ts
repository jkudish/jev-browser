import { ask, resolveTransport } from "@jkudish/jev-agent-tools";
import type { JevAnswer, JevTransport, JevTransportInput, JevTransportReply } from "@jkudish/jev-agent-tools";

export { resolveTransport };
export type { JevAnswer, JevTransport, JevTransportInput, JevTransportReply };

export interface AskResult {
  answers: Record<string, JevAnswer>;
  usage: JevTransportReply["usage"];
  provider: string;
  model: string;
}

/** Internal marker so a failed judgment cannot be mistaken for a page action error. */
export class InvalidJevAnswer extends Error {}

export async function askJev(transport: JevTransport, input: JevTransportInput): Promise<AskResult> {
  const result = await ask(input, { transport });
  if (!result.ok) {
    if (input.signal.aborted) throw input.signal.reason;
    if (result.code === "request_failed") throw new Error(result.message);
    throw new InvalidJevAnswer(result.message);
  }
  // The package redacts unrecognized names; successful injected transports
  // still report the caller's name, as the public navigate() API promises.
  const provider = typeof transport.name === "string" && transport.name.trim() ? transport.name : "unknown";
  return { answers: result.answer, usage: result.usage, provider, model: result.model };
}
