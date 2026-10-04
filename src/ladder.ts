// OpenRouter decision models, cheapest first. A slash means the id is already
// a provider/model slug and must not be prefixed with typesafe/.
export const DEFAULT_LADDER = [
  "inception/mercury-decide:free",
  "perplexity/pplx-decider-v1-27b",
  "liquid/d1",
  "typesafe/jev-1.13",
  "togethercomputer/tev1-4b-experimental",
  "cloudflare/clef-flash",
  "cloudflare/clef",
];

export function modelLadder(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.JEV_BROWSER_MODELS;
  if (raw && raw.trim()) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return DEFAULT_LADDER;
}

export function confidenceFloor(env: Record<string, string | undefined> = process.env): number {
  const raw = env.JEV_BROWSER_CONFIDENCE_FLOOR;
  if (raw == null || raw === "") return 0.7;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0.7;
}

export function openrouterSlug(model: string): string {
  if (model.includes("/")) return model;
  if (model === "jev-latest") return "typesafe/jev-1.13";
  return `typesafe/${model}`;
}

// 401/403 is the key, not the model. Everything else on one model falls through.
export function shouldFallthrough(code: string, message: string): boolean {
  if (/HTTP 401|HTTP 403/.test(message)) return false;
  return code === "rate_limited"
    || code === "unavailable"
    || code === "request_failed"
    || code === "malformed_answer"
    || code === "answer_id_mismatch"
    || code === "invalid_choice"
    || code === "invalid_noul"
    || code === "invalid_confidence"
    || code === "invalid_distribution"
    || code === "invalid_model"
    || code === "invalid_usage";
}

export function confidentEnough(confidence: number | null, floor: number): boolean {
  return (confidence ?? 0) >= floor;
}
