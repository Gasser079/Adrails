import test from "node:test";
import assert from "node:assert";
import { buildThinkTools, buildToolRuntime } from "../tools.js";

const hooks = {
  runtime: async () => ({ ok: false, error: "no tenant here" }) as const,
  collect: () => {},
  attempt: () => {},
};

test("think tools: trimmed discovery + ledger tools, safe names only", () => {
  const tools = buildThinkTools("What are the required parameters of createCustomerClient?", hooks);
  const names = Object.keys(tools);
  assert.ok(names.includes("propose_ledger_action"), "ledger propose present");
  assert.ok(names.includes("ledger_status"), "ledger status present");
  assert.ok(names.length >= 14, `expected 12 trimmed + 2 ledger, got ${names.length}`);
  for (const n of names) assert.match(n, /^[a-zA-Z0-9_-]{1,64}$/, `unsafe tool name ${n}`);
});

test("think tools: execute surfaces runtime errors as text, never throws", async () => {
  const tools = buildThinkTools("budgets", hooks) as unknown as Record<string, { execute: (args: unknown) => Promise<unknown> }>;
  const out = await tools.propose_ledger_action.execute({ actionType: "x", customerId: "1", payload: {} });
  assert.match(String(out), /tool unavailable: no tenant here/);
});

test("think runtime: unknown tenant fails closed with guidance", async () => {
  const db = { prepare: () => ({ bind: () => ({ first: async () => null }) }) };
  const r = await buildToolRuntime({ LEDGER_DB: db, CACHE: null }, "ghost");
  assert.strictEqual(r.ok, false);
});
