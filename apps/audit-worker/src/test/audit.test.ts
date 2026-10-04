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
    assert.strictEqual(s.conversionLoss, 0, "no dated conversion rows in fixture");
    assert.strictEqual(s.impressionShare, 0, "no share rows in fixture");
    assert.strictEqual(s.uploadHealth, 1, "empty upload summary records the stop-rule finding");
    const findings = await deps.findings.listByTenant("agency");
    assert.strictEqual(findings.length, 5);
    assert.ok(findings.some((f) => f.kind === "policy" && f.severity === "critical"));
    const recFindings = findings.filter((f) => f.kind === "recommendation");
    assert.ok(recFindings.every((f) => typeof f.ledgerId === "string"), "every recommendation links a ledger proposal");
    const pending = await deps.ledger.pendingByTenant("agency");
    assert.strictEqual(pending.length, 2, "recommendations wait as PROPOSED ledger rows");
    assert.ok(pending.every((p) => p.actionType === "recommendation.triage"));
  } finally { db.close(); }
});

test("audit: diagnostics scans — conversion drop, budget-vs-rank, upload shortfall + stop rule", async () => {
  const db = memDb();
  try {
    await seedTenant(db);
    const deps = depsFor(db, (q) => {
      if (q.includes("metrics.conversions")) {
        return [
          { campaign: { name: "c" }, metrics: { conversions: 2, conversions_value: 20, cost_micros: 1000000 }, segments: { date: "2026-09-28" } },
          { campaign: { name: "c" }, metrics: { conversions: 10, conversions_value: 100, cost_micros: 1000000 }, segments: { date: "2026-09-27" } },
          { campaign: { name: "c" }, metrics: { conversions: 10, conversions_value: 100, cost_micros: 1000000 }, segments: { date: "2026-09-26" } },
        ];
      }
      if (q.includes("search_budget_lost_impression_share")) {
        return [
          { campaign: { name: "starved" }, metrics: { search_budget_lost_impression_share: 0.35, search_rank_lost_impression_share: 0.05 } },
          { campaign: { name: "weak" }, metrics: { search_budget_lost_impression_share: 0.05, search_rank_lost_impression_share: 0.4 } },
          { campaign: { name: "fine" }, metrics: { search_budget_lost_impression_share: 0.05, search_rank_lost_impression_share: 0.05 } },
        ];
      }
      if (q.includes("offline_conversion_upload_conversion_action_summary")) {
        return [
          { offline_conversion_upload_conversion_action_summary: { conversion_action_name: "store", successful_event_count: 7, total_event_count: 10, status: "OK" } },
          { offline_conversion_upload_conversion_action_summary: { conversion_action_name: "clean", successful_event_count: 10, total_event_count: 10, status: "OK" } },
        ];
      }
      return [];
    });
    const { conversionLossScan, impressionShareScan, offlineUploadHealthScan } = await import("../scans.js");
    assert.strictEqual(await conversionLossScan(deps, "agency", "123", new Date("2026-09-20T00:00:00Z")), 1);
    assert.strictEqual(await impressionShareScan(deps, "agency", "123"), 2);
    assert.strictEqual(await offlineUploadHealthScan(deps, "agency", "123"), 1);
    const findings = await deps.findings.listByTenant("agency");
    const conv = findings.find((f) => f.summary.includes("Conversion drop"));
    assert.ok(conv && conv.severity === "warning");
    const budget = findings.find((f) => f.summary.includes("starved"));
    assert.ok(budget && budget.summary.includes("budget (raise caps"));
    const rank = findings.find((f) => f.summary.includes("weak"));
    assert.ok(rank && rank.summary.includes("rank (bids"));
    assert.ok(findings.some((f) => f.summary.includes("Upload shortfall on store: 7/10")));
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
