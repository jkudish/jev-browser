// Type-level check, compiled by `npm run typecheck` and never run: a library
// consumer can use the Discern type names and the deprecated Jev* aliases
// interchangeably through 1.x.
import { navigate } from "../src/library.js";
import type {
  DiscernAnswer,
  DiscernTransport,
  DiscernTransportInput,
  DiscernTransportReply,
  DiscernUsage,
  JevAnswer,
  JevTransport,
  JevTransportInput,
  JevTransportReply,
  JevUsage,
  NavigateOptions,
  NavigateResult,
} from "../src/library.js";

const discern: DiscernTransport = {
  name: "check",
  async ask(input: DiscernTransportInput): Promise<DiscernTransportReply> {
    return { answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, model: input.model };
  },
};
const legacy: JevTransport = discern;
const back: DiscernTransport = legacy;
const legacyInput: JevTransportInput = { state: {}, questions: {}, model: "jev-latest", signal: new AbortController().signal };
const legacyReply: JevTransportReply = { answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, model: "m" };
const answer: DiscernAnswer = { type: "noul", noul: 0.5 };
const legacyAnswer: JevAnswer = answer;

// NavigateOptions.transport accepts either name.
const withDiscern: NavigateOptions = { task: "t", startUrl: "https://example.com", transport: discern };
const withJev: NavigateOptions = { task: "t", startUrl: "https://example.com", transport: legacy };

async function readResult(): Promise<void> {
  const result: NavigateResult = await navigate(withDiscern);
  const usage: DiscernUsage = result.usage;
  const legacyUsage: JevUsage = usage;
  const calls: number = usage.judgment_calls + legacyUsage.jev_calls;
  const provider: string | null = result.judgment_provider ?? result.jev_provider;
  // Undeclared result fields stay loosely typed, as in 0.x.
  const finalUrl: string = result.final_url;
  void [calls, provider, finalUrl];
}

void [back, legacyInput, legacyReply, legacyAnswer, withJev, readResult];
