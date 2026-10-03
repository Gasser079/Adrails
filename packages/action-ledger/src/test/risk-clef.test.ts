import test from "node:test";
import assert from "node:assert";
import { evaluateRiskWithClef, riskQuestions, type AiPort } from "../risk-clef.js";

const aiReturning = (answers: unknown): AiPort => ({
  run: async () => ({ answers }),
});

test("risk-clef: maps live shape (choice + legend-indexed score)", async () => {
  const out = await evaluateRiskWithClef(
    aiReturning({
      tier: { choice: "high", probabilities: { high: 0.8667, medium: 0.1183, low: 0.015 } },
      risk_score: {
        score: 2.2226,
        legend: { 0: "Negligible", 1: "Low", 2: "Moderate", 3: "High", 4: "Critical" },
      },
    }),
    "budget.update",
    "{}",
  );
  assert.strictEqual(out.tier, "high");
  assert.ok(Math.abs(out.score - 2.2226 / 4) < 1e-9, `legend-normalized score (got ${out.score})`);
  assert.strictEqual(out.model, "clef-flash");
  assert.deepStrictEqual(out.probabilities, { high: 0.8667, medium: 0.1183, low: 0.015 });
});

test("risk-clef: malformed answers throw (caller falls back, never trusts)", async () => {
  await assert.rejects(evaluateRiskWithClef(aiReturning({}), "x", "{}"), /clef_malformed/);
  await assert.rejects(
    evaluateRiskWithClef(aiReturning({ tier: { choice: "extreme" }, risk_score: { score: 2, legend: { 0: "a", 4: "b" } } }), "x", "{}"),
    /clef_malformed/,
  );
  await assert.rejects(
    evaluateRiskWithClef(aiReturning({ tier: { choice: "low" }, risk_score: { score: 99 } }), "x", "{}"),
    /clef_malformed/,
    "out-of-range score without legend must refuse, not misread",
  );
  await assert.rejects(
    evaluateRiskWithClef({ run: async () => { throw new Error("ai down"); } }, "x", "{}"),
    /ai down/,
  );
});

test("risk-clef: questions carry criteria mirroring the deterministic tiers", () => {
  const q = riskQuestions("campaign.create", "{}") as Record<string, { criteria: Record<string, string> }>;
  assert.ok(q.tier.criteria.high.includes("Budget") || q.tier.criteria.high.includes("budget"));
  assert.ok(q.tier.criteria.low.includes("Read-only") || q.tier.criteria.low.includes("read"));
});
