// @adrails/action-ledger/risk-clef — Clef-based risk evaluation (opt-in).
// Same {score, tier} shape as the deterministic evaluator, plus per-option
// probabilities. Callers MUST fall back to evaluateRisk() on any throw —
// an AI outage or malformed answer can never block or corrupt a proposal.
import type { RiskTier } from "@adrails/shared-types";

export interface AiPort {
  run(model: string, input: unknown): Promise<unknown>;
}

export interface ClefEvaluation {
  score: number;
  tier: RiskTier;
  probabilities: Record<string, number>;
  model: string;
}

const CLEF_FLASH = "clef-flash";

const TIER_CRITERIA: Record<RiskTier, string> = {
  low: "Read-only queries, audits, forecasts, drafts, validations. No external state changes.",
  medium: "Reversible or low-blast-radius changes, recommendations triage, non-monetary updates.",
  high: "Budget changes, structural creates/deletes, bulk mutates, monetary uploads, irreversible actions.",
};

const SCORE_LEVELS = ["Negligible risk", "Low risk", "Moderate risk", "High risk", "Critical risk"];

export function riskQuestions(actionType: string, payloadSummary: string): Record<string, unknown> {
  return {
    tier: {
      type: "choice",
      instructions: `Which risk tier does this ad-platform action belong to? Action: ${actionType}. Payload: ${payloadSummary}`,
      criteria: TIER_CRITERIA,
    },
    risk_score: {
      type: "score",
      instructions: `How risky is this ad-platform action from 0 (harmless read) to 1 (irreversible monetary/structural change)? Action: ${actionType}.`,
      criteria: SCORE_LEVELS,
    },
  };
}

interface ClefAnswers {
  tier?: { choice?: string; value?: string; probabilities?: Record<string, number> };
  risk_score?: { value?: number; score?: number; legend?: Record<string, string> };
}

const asTier = (v: unknown): RiskTier | null =>
  v === "low" || v === "medium" || v === "high" ? v : null;

/** Normalize an index-based score using the legend scale (live shape). */
function normalizeScore(raw: number, legend: Record<string, string> | undefined): number | null {
  if (legend && typeof legend === "object") {
    const idxs = Object.keys(legend).map(Number).filter((n) => Number.isFinite(n));
    const max = idxs.length ? Math.max(...idxs) : 0;
    if (max > 0) return Math.max(0, Math.min(1, raw / max));
    return null;
  }
  if (raw >= 0 && raw <= 1) return raw;
  return null; // out-of-range without a legend: refuse rather than misread
}

export async function evaluateRiskWithClef(
  ai: AiPort,
  actionType: string,
  payloadSummary: string,
  model: string = CLEF_FLASH,
): Promise<ClefEvaluation> {
  const out = (await ai.run(model, {
    model,
    state: `Ad action risk assessment. Action: ${actionType}. Payload: ${payloadSummary}`,
    questions: riskQuestions(actionType, payloadSummary),
  })) as { answers?: ClefAnswers };
  const answers = out?.answers;
  if (!answers || typeof answers !== "object") throw new Error("clef_malformed: missing answers");
  // Live shape: tier.choice + risk_score.score (index into legend scale).
  // Tolerate the symmetric .value shape; anything else is malformed.
  const tier = asTier(answers.tier?.choice ?? answers.tier?.value);
  const raw = answers.risk_score?.score ?? answers.risk_score?.value;
  if (!tier || typeof raw !== "number" || Number.isNaN(raw)) {
    throw new Error("clef_malformed: tier must be low|medium|high and risk_score a number");
  }
  const score = normalizeScore(raw, answers.risk_score?.legend);
  if (score === null) throw new Error("clef_malformed: risk_score scale uninterpretable");
  return { score, tier, probabilities: answers.tier?.probabilities ?? {}, model };
}
