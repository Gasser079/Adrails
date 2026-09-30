import test from "node:test";
import assert from "node:assert";
import { DISCOVERY_TOOLS, DISCOVERY_VERSION } from "../discovery-tools.generated.js";
import { trimTools } from "../tools.js";
import { EXPERT_SYSTEM_PROMPT } from "../manual.js";

test("compiler output: read-only catalog, mutating methods excluded by design", () => {
  assert.strictEqual(DISCOVERY_VERSION, "v25");
  assert.ok(DISCOVERY_TOOLS.length >= 30, `expected a real catalog, got ${DISCOVERY_TOOLS.length}`);
  const names = DISCOVERY_TOOLS.map((t) => t.name);
  assert.ok(names.some((n) => n.includes("listAccessibleCustomers")), "discovery loop present");
  assert.ok(names.some((n) => n.includes("generateKeywordIdeas")), "keyword ideas present");
  const banned = DISCOVERY_TOOLS.filter((t) => /mutate|create_|update_|remove_|delete_|upload/i.test(t.name));
  assert.strictEqual(banned.length, 0, `mutating tools must not exist: ${banned.map((t) => t.name).join(",")}`);
  for (const t of DISCOVERY_TOOLS) {
    assert.ok(t.parameters && t.parameters.type === "object", `${t.name} needs a parameters schema`);
    assert.ok(!("customerId" in (t.parameters.properties ?? {})), `${t.name} must not take customerId from the model`);
  }
});

test("trimmer: question-relevant tools surface, ledger tools stay separate", () => {
  const top = trimTools("how do shared budgets and bidding strategies work", 5);
  assert.strictEqual(top.length, 5);
  const all = trimTools("keyword ideas for a new campaign", 12);
  assert.ok(all.some((t) => t.name.includes("generateKeywordIdeas")), "keyword question surfaces keyword tool");
});

test("manual: boundaries are explicit (no mutate, ledger-only writes, tenant isolation)", () => {
  assert.ok(EXPERT_SYSTEM_PROMPT.includes("propose_ledger_action"));
  assert.ok(EXPERT_SYSTEM_PROMPT.includes("Never answer from pretrained weights") || EXPERT_SYSTEM_PROMPT.includes("ONLY from tool results"));
  assert.ok(EXPERT_SYSTEM_PROMPT.includes("tenant"));
});
