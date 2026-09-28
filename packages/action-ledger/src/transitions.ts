// @adrails/action-ledger/transitions — the canonical lifecycle. Nothing in the
// system may write a status that is not reachable from the current one.
import type { ActionStatus, RiskTier } from "@adrails/shared-types";

export const LEGAL_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  PROPOSED: ["VALIDATED", "REJECTED", "EXPIRED"],
  VALIDATED: ["APPROVED", "REJECTED", "INVALIDATED", "EXPIRED"],
  APPROVED: ["DISPATCHED", "EXPIRED"],
  DISPATCHED: ["EXECUTED", "FAILED"],
  EXECUTED: [],
  REJECTED: [],
  INVALIDATED: [],
  FAILED: ["DISPATCHED"],
  EXPIRED: [],
};

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return LEGAL_TRANSITIONS[from]?.includes(to) ?? false;
}

export interface RiskEvaluation {
  score: number;
  tier: RiskTier;
}

/**
 * Deterministic risk tiers (no LLM involved). Structural + monetary + bulk
 * mutations are high; reads/drafts are low; everything else is medium.
 */
export function evaluateRisk(actionType: string, explicitScore?: number): RiskEvaluation {
  if (explicitScore !== undefined) {
    const score = Math.max(0, Math.min(1, explicitScore));
    return { score, tier: score < 0.2 ? "low" : score <= 0.7 ? "medium" : "high" };
  }
  const high = /budget|delete|remove|campaign\.create|mutate|upload/i;
  const low = /^(search|audit|forecast|ideas|report|draft|validate)_?/i;
  const norm = actionType.toLowerCase();
  if (high.test(norm)) return { score: 0.85, tier: "high" };
  if (low.test(norm)) return { score: 0.1, tier: "low" };
  return { score: 0.5, tier: "medium" };
}
