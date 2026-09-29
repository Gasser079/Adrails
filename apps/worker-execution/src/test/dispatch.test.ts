import test from "node:test";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleDispatchBatch, type DispatchMessage } from "../index.js";
import { ActionLedgerRepository, type D1Like } from "@adrails/action-ledger";
import { GoogleAdsRestClient, AdsApiError } from "@adrails/ads-client";

function memDb(): D1Like & { close(): void } {
  const db = new DatabaseSync(":memory:");
  const migDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");
  for (const f of ["0001_action_ledger.sql", "0002_tenant_oauth.sql", "0003_audit_findings.sql"]) {
    db.exec(fs.readFileSync(path.join(migDir, f), "utf8"));
  }
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

interface Msg {
  body: DispatchMessage;
  acked: boolean;
  ack(): void;
  retry(): void;
}
const batchOf = (bodies: DispatchMessage[]) => ({
  messages: bodies.map((body) => ({ body, acked: false, ack() { (this as Msg).acked = true; }, retry() {} }) as Msg),
});

function depsWithMutate(
  db: D1Like,
  mutate: (tenantId: string, customerId: string, ops: unknown[]) => Promise<unknown>,
) {
  return {
    ledger: new ActionLedgerRepository(db),
    ads: { mutate } as unknown as GoogleAdsRestClient,
  };
}

async function approvedRow(db: D1Like, payload: unknown = { mutate_operations: [{ op: 1 }] }) {
  const ledger = new ActionLedgerRepository(db);
  const rec = await ledger.record({
    tenantId: "agency", customerId: "123", actionType: "campaign.create",
    requestId: "r", scope: "customers/123", payload, createdBy: "USER_EXPLICIT",
  });
  await ledger.transition(rec.id, "VALIDATED", "system");
  return ledger.transition(rec.id, "APPROVED", "gasser");
}

test("dispatcher: approved row mutates and lands EXECUTED", async () => {
  const db = memDb();
  try {
    let called: unknown[] | null = null;
    const deps = depsWithMutate(db, async (_t, _c, ops) => { called = ops; return { mutateOperationResponses: [{ ok: 1 }] }; });
    const rec = await approvedRow(db);
    const batch = batchOf([{ ledgerId: rec.id, tenantId: "agency", customerId: "123" }]);
    await handleDispatchBatch(batch, deps);
    assert.ok(batch.messages[0].acked);
    assert.deepStrictEqual(called, [{ op: 1 }]);
    assert.strictEqual((await deps.ledger.getById(rec.id))?.status, "EXECUTED");
  } finally { db.close(); }
});

test("dispatcher: validation-classified failure lands FAILED (no retry storm)", async () => {
  const db = memDb();
  try {
    const deps = depsWithMutate(db, async () => {
      throw new AdsApiError({ message: "bad", category: "VALIDATION", providerCode: "fieldError.X", retryable: false, countsTowardBreaker: false });
    });
    const rec = await approvedRow(db);
    const batch = batchOf([{ ledgerId: rec.id, tenantId: "agency", customerId: "123" }]);
    await handleDispatchBatch(batch, deps);
    assert.ok(batch.messages[0].acked);
    assert.strictEqual((await deps.ledger.getById(rec.id))?.status, "FAILED");
  } finally { db.close(); }
});

test("dispatcher: transient failure rethrows (Queue redelivers, DLQ bounds it)", async () => {
  const db = memDb();
  try {
    const deps = depsWithMutate(db, async () => {
      throw new AdsApiError({ message: "slow", category: "RATE_LIMIT", providerCode: "q.X", retryable: true, countsTowardBreaker: false });
    });
    const rec = await approvedRow(db);
    await assert.rejects(
      handleDispatchBatch(batchOf([{ ledgerId: rec.id, tenantId: "agency", customerId: "123" }]), deps),
      /slow/,
    );
    assert.strictEqual((await deps.ledger.getById(rec.id))?.status, "DISPATCHED", "row waits, not FAILED");
  } finally { db.close(); }
});

test("dispatcher: settled + malformed rows never execute", async () => {
  const db = memDb();
  try {
    let calls = 0;
    const deps = depsWithMutate(db, async () => { calls++; return {}; });
    const rec = await approvedRow(db, { nope: 1 });
    const batch = batchOf([{ ledgerId: rec.id, tenantId: "agency", customerId: "123" }]);
    await handleDispatchBatch(batch, deps);
    assert.strictEqual(calls, 0, "payload without mutate_operations[] must not reach Google");
    assert.strictEqual((await deps.ledger.getById(rec.id))?.status, "FAILED");
    // already-executed row: skip silently
    const done = await approvedRow(db);
    const ledger = new ActionLedgerRepository(db);
    await ledger.transition(done.id, "DISPATCHED", "dispatcher");
    await ledger.transition(done.id, "EXECUTED", "dispatcher");
    await handleDispatchBatch(batchOf([{ ledgerId: done.id, tenantId: "agency", customerId: "123" }]), deps);
    assert.strictEqual(calls, 0);
  } finally { db.close(); }
});
