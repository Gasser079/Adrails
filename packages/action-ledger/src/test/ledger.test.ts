import test from "node:test";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ActionLedgerRepository, type D1Like } from "../repository.js";
import { canTransition, evaluateRisk } from "../transitions.js";

function memDb(): D1Like & { close(): void } {
  const db = new DatabaseSync(":memory:");
  const ddl = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations", "0001_action_ledger.sql"),
    "utf8",
  );
  db.exec(ddl);
  return {
    close: () => db.close(),
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => db.prepare(sql).run(...(values as [])),
        first: async <T>() => {
          const rows = db.prepare(sql).all(...(values as [])) as unknown as T[];
          return rows[0] ?? null;
        },
        all: async <T>() => ({ results: db.prepare(sql).all(...(values as [])) as unknown as T[] }),
      }),
    }),
  };
}

test("transitions: legal paths allowed, terminal states + skips rejected", () => {
  assert.ok(canTransition("PROPOSED", "VALIDATED"));
  assert.ok(canTransition("VALIDATED", "APPROVED"));
  assert.ok(canTransition("APPROVED", "DISPATCHED"));
  assert.ok(canTransition("DISPATCHED", "EXECUTED"));
  assert.ok(canTransition("DISPATCHED", "FAILED"));
  assert.ok(!canTransition("PROPOSED", "EXECUTED"), "no skipping the ledger");
  assert.ok(!canTransition("EXECUTED", "FAILED"), "terminal state is terminal");
  assert.ok(!canTransition("REJECTED", "APPROVED"));
});

test("risk tiers: structural/budget high, reads low, default medium", () => {
  assert.strictEqual(evaluateRisk("budget.update").tier, "high");
  assert.strictEqual(evaluateRisk("campaign.create").tier, "high");
  assert.strictEqual(evaluateRisk("search_forecast").tier, "low");
  assert.strictEqual(evaluateRisk("audit_account").tier, "low");
  assert.strictEqual(evaluateRisk("something_new").tier, "medium");
  assert.strictEqual(evaluateRisk("anything", 0.9).tier, "high");
});

test("repository: record -> validate -> approve -> dispatch -> execute, events appended", async () => {
  const db = memDb();
  try {
    const repo = new ActionLedgerRepository(db, () => 1700000000);
    const rec = await repo.record({
      tenantId: "agency-1", customerId: "1234567890", actionType: "budget.update",
      requestId: "req-1", scope: "customers/1234567890", payload: { micros: 5000000 },
      createdBy: "SYSTEM_AI",
    });
    assert.strictEqual(rec.status, "PROPOSED");
    assert.strictEqual(rec.riskTier, "high");
    assert.strictEqual(rec.createdAt, new Date(1700000000 * 1000).toISOString());

    await repo.transition(rec.id, "VALIDATED", "system");
    const approved = await repo.transition(rec.id, "APPROVED", "gasser");
    assert.strictEqual(approved.status, "APPROVED");
    await repo.transition(rec.id, "DISPATCHED", "worker");
    const done = await repo.transition(rec.id, "EXECUTED", "worker");
    assert.strictEqual(done.status, "EXECUTED");

    const pending = await repo.pendingByTenant("agency-1");
    assert.strictEqual(pending.length, 0, "executed records leave the pending queue");
  } finally { db.close(); }
});

test("repository: illegal transition throws, idempotency enforced", async () => {
  const db = memDb();
  try {
    const repo = new ActionLedgerRepository(db, () => 1700000000);
    const rec = await repo.record({
      tenantId: "t", customerId: "1", actionType: "campaign.create",
      requestId: "r", scope: "s", payload: {}, createdBy: "USER_EXPLICIT",
      idempotencyKey: "idem-1",
    });
    await assert.rejects(repo.transition(rec.id, "EXECUTED", "x"), /illegal_ledger_transition/);
    await assert.rejects(
      repo.record({ tenantId: "t", customerId: "1", actionType: "campaign.create", requestId: "r2", scope: "s", payload: {}, createdBy: "USER_EXPLICIT", idempotencyKey: "idem-1" }),
      /UNIQUE|unique/i,
    );
  } finally { db.close(); }
});
