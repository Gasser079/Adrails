import test from "node:test";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../index.js";
import { ActionLedgerRepository, TenantRepository, type D1Like } from "@adrails/action-ledger";
import { GoogleAdsRestClient } from "@adrails/ads-client";

function memDb(): D1Like & { close(): void } {
  const db = new DatabaseSync(":memory:");
  const migDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");
  for (const f of ["0001_action_ledger.sql", "0002_tenant_oauth.sql"]) {
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

function mockAdsFetch() {
  return (async (url: unknown, init?: { body?: string }) => {
    const u = String(url);
    if (u.includes("customers:listAccessibleCustomers")) {
      return { ok: true, status: 200, json: async () => ({ resourceNames: ["customers/111"] }), text: async () => "{}" };
    }
    return { ok: true, status: 200, json: async () => ({ results: [{ q: (init?.body ?? "").slice(0, 20) }] }), text: async () => "{}" };
  }) as typeof fetch;
}

function app() {
  const db = memDb();
  const sent: unknown[] = [];
  const deps = {
    ledger: new ActionLedgerRepository(db),
    tenant: new TenantRepository(db),
    queue: { send: async (m: unknown) => { sent.push(m); } },
    ads: new GoogleAdsRestClient({
      fetchFn: mockAdsFetch(),
      authProvider: { getAuthContext: async () => ({ accessToken: "t", customerId: "123", loginCustomerId: "456" }) },
      kv: null,
    }),
  };
  return { app: createApp(deps), db, sent };
}

test("worker-api: health + propose -> pending -> approve (golden-rule path)", async () => {
  const { app: a, db, sent } = app();
  try {
    const h = await a.request("/health");
    assert.strictEqual(h.status, 200);
    assert.strictEqual((await h.json() as { status: string }).status, "ok");

    const p = await a.request("/v1/ledger/propose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: "agency", customerId: "123", actionType: "budget.update",
        requestId: "r1", scope: "customers/123", payload: { micros: 100 }, createdBy: "SYSTEM_AI",
      }),
    });
    assert.strictEqual(p.status, 201);
    const rec = (await p.json()) as { id: string; status: string; riskTier: string };
    assert.strictEqual(rec.status, "PROPOSED");
    assert.strictEqual(rec.riskTier, "high");

    const pend = await a.request("/v1/ledger/pending?tenantId=agency");
    assert.strictEqual(((await pend.json()) as { pending: unknown[] }).pending.length, 1);

    const val = await a.request(`/v1/ledger/${rec.id}/validate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "system" }),
    });
    assert.strictEqual(((await val.json()) as { status: string }).status, "VALIDATED");

    const ap = await a.request(`/v1/ledger/${rec.id}/approve`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor: "gasser" }),
    });
    assert.strictEqual(ap.status, 200);
    const dispatched = (await ap.json()) as { status: string };
    assert.strictEqual(dispatched.status, "DISPATCHED", "approve enqueues and moves to DISPATCHED");
    assert.strictEqual(sent.length, 1, "exactly one queue message per approval");
    assert.deepStrictEqual(sent[0], { ledgerId: rec.id, tenantId: "agency", customerId: "123" });
  } finally { db.close(); }
});

test("worker-api: zod validation is 400 (customer dashes rejected)", async () => {
  const { app: a, db } = app();
  try {
    const bad = await a.request("/v1/ledger/propose", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: "agency", customerId: "12-34", actionType: "x",
        requestId: "r", scope: "s", payload: {}, createdBy: "USER_EXPLICIT",
      }),
    });
    assert.strictEqual(bad.status, 400);
  } finally { db.close(); }
});

test("worker-api: L1 read-only strategy routes (no ledger writes)", async () => {
  const { app: a, db } = app();
  try {
    const d = await a.request("/v1/strategy/account-discovery", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "agency", loginCustomerId: "1000000001" }),
    });
    assert.strictEqual(d.status, 200);
    const disc = (await d.json()) as { manager: string; clients: Array<{ customerId: string }> };
    assert.strictEqual(disc.manager, "1000000001");
    assert.deepStrictEqual(disc.clients.map((c) => c.customerId), ["111"]);

    const g = await a.request("/v1/strategy/gaql", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "agency", customerId: "123", query: "SELECT campaign.id FROM campaign" }),
    });
    assert.strictEqual(g.status, 200);
    assert.ok(Array.isArray((await g.json() as { results: unknown[] }).results));

    const pend = await a.request("/v1/ledger/pending?tenantId=agency");
    assert.strictEqual(((await pend.json()) as { pending: unknown[] }).pending.length, 0, "reads never touch the ledger");
  } finally { db.close(); }
});
