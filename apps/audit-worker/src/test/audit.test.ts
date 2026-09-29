import test from "node:test";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit } from "../index.js";
import { scanCustomer } from "../scans.js";
import { ActionLedgerRepository, TenantRepository, AuditFindingsRepository, type D1Like } from "@adrails/action-ledger";

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

function depsFor(db: D1Like, gaql: (query: string) => unknown[]) {
  return {
    ledger: new ActionLedgerRepository(db),
    tenant: new TenantRepository(db),
    findings: new AuditFindingsRepository(db),
    ads: { searchGaql: async (input: { query: string }) => gaql(input.query) } as unknown as import("@adrails/ads-client").GoogleAdsRestClient,
  };
}

async function seedTenant(db: D1Like) {
  const tenant = new TenantRepository(db);
  await tenant.upsertTenant({ tenantId: "agency", loginCustomerId: "1000000001", scopes: "s", tokenSource: "t" });
  await tenant.replaceClients("agency", [{ customerId: "123", resourceName: "customers/123" }]);
}

test("audit: drift + policy findings recorded, recommendations become ledger proposals", async () => {
  const db = memDb();
  try {
    await seedTenant(db);
    const deps = depsFor(db, (q) => {
      if (q.includes("FROM change_event")) return [{ changeEvent: { changeResourceName: "r", clientType: "GOOGLE_ADS_WEB_CLIENT", userEmail: "u", resourceStatus: "x" } }];
      if (q.includes("policy_summary")) return [{ adGroupAd: { ad: { id: "7" }, policySummary: { approvalStatus: "DISAPPROVED", reviewStatus: "REVIEWED" } } }];
      if (q.includes("FROM recommendation")) {
        return [
          { recommendation: { type: "CAMPAIGN_BUDGET", resourceName: "customers/123/recommendations/1" } },
          { recommendation: { type: "KEYWORD", resourceName: "customers/123/recommendations/2" } },
        ];
      }
      return [];
    });
    const s = await scanCustomer(deps, "agency", "123", new Date("2026-09-28T00:00:00Z"));
    assert.strictEqual(s.drift, 1);
    assert.strictEqual(s.policy, 1);
    assert.strictEqual(s.recommendations, 2);
    const findings = await deps.findings.listByTenant("agency");
    assert.strictEqual(findings.length, 4);
    assert.ok(findings.some((f) => f.kind === "policy" && f.severity === "critical"));
    const recFindings = findings.filter((f) => f.kind === "recommendation");
    assert.ok(recFindings.every((f) => typeof f.ledgerId === "string"), "every recommendation links a ledger proposal");
    const pending = await deps.ledger.pendingByTenant("agency");
    assert.strictEqual(pending.length, 2, "recommendations wait as PROPOSED ledger rows");
    assert.ok(pending.every((p) => p.actionType === "recommendation.triage"));
  } finally { db.close(); }
});

test("audit: runAudit walks every tenant client and isolates per-client failures", async () => {
  const db = memDb();
  try {
    await seedTenant(db);
    const deps = depsFor(db, (q) => {
      if (q.includes("FROM recommendation")) throw new Error("rec down");
      if (q.includes("policy_summary")) return [];
      if (q.includes("FROM change_event")) return [];
      return [];
    });
    const out = await runAudit(deps, new Date("2026-09-28T00:00:00Z"));
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual([out[0].drift, out[0].policy, out[0].recommendations], [0, 0, 0]);
  } finally { db.close(); }
});
