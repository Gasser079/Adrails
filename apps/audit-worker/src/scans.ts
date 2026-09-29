// @adrails/audit-worker/scans — the three read-only watchdog scans.
// Findings are recorded; anything actionable becomes a PROPOSED ledger row.
// This worker never mutates Google state.
import type { AuditDeps } from "./env.js";

export interface ScanSummary {
  tenantId: string;
  customerId: string;
  drift: number;
  policy: number;
  recommendations: number;
}

const gaqlDateTime = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " ");

interface GaqlRow {
  [k: string]: unknown;
}

/** Change-event drift: every recent external change is recorded for reconciliation. */
export async function driftScan(deps: AuditDeps, tenantId: string, customerId: string, since: Date): Promise<number> {
  const query =
    `SELECT change_event.change_date_time, change_event.change_resource_name, ` +
    `change_event.client_type, change_event.user_email, change_event.resource_status ` +
    `FROM change_event WHERE change_event.change_date_time > '${gaqlDateTime(since)}' ` +
    `ORDER BY change_event.change_date_time DESC LIMIT 50`;
  const rows = (await deps.ads.searchGaql({ tenantId, customerId, query })) as GaqlRow[];
  let n = 0;
  for (const r of rows) {
    const ce = (r.changeEvent ?? r.change_event ?? r) as Record<string, unknown>;
    await deps.findings.record({
      tenantId,
      customerId,
      kind: "drift",
      severity: "info",
      summary: `External change: ${String(ce.changeResourceName ?? ce.change_resource_name ?? "unknown")} via ${String(ce.clientType ?? ce.client_type ?? "unknown")}`,
      details: JSON.stringify(ce).slice(0, 1000),
    });
    n++;
  }
  return n;
}

/** Policy disapprovals: any non-approved ad is a critical finding. */
export async function policyScan(deps: AuditDeps, tenantId: string, customerId: string): Promise<number> {
  const query =
    `SELECT ad_group_ad.ad.id, ad_group_ad.policy_summary.review_status, ` +
    `ad_group_ad.policy_summary.approval_status FROM ad_group_ad ` +
    `WHERE ad_group_ad.policy_summary.approval_status != 'APPROVED' LIMIT 50`;
  const rows = (await deps.ads.searchGaql({ tenantId, customerId, query })) as GaqlRow[];
  let n = 0;
  for (const r of rows) {
    const ad = (r.adGroupAd ?? r.ad_group_ad ?? r) as Record<string, unknown>;
    const summary = (ad.policySummary ?? ad.policy_summary ?? {}) as Record<string, unknown>;
    await deps.findings.record({
      tenantId,
      customerId,
      kind: "policy",
      severity: "critical",
      summary: `Ad ${String((ad.ad as Record<string, unknown>)?.id ?? "?")}: approval=${String(summary.approvalStatus ?? summary.approval_status ?? "?")} review=${String(summary.reviewStatus ?? summary.review_status ?? "?")}`,
      details: JSON.stringify(summary).slice(0, 1000),
    });
    n++;
  }
  return n;
}

/** Recommendations become PROPOSED ledger rows (triage), never auto-applied. */
export async function recommendationScan(deps: AuditDeps, tenantId: string, customerId: string, limit = 10): Promise<number> {
  const query =
    `SELECT recommendation.resource_name, recommendation.type, recommendation.campaign ` +
    `FROM recommendation LIMIT ${Math.min(Math.max(limit, 1), 25)}`;
  const rows = (await deps.ads.searchGaql({ tenantId, customerId, query })) as GaqlRow[];
  let n = 0;
  for (const r of rows) {
    const rec = (r.recommendation ?? r) as Record<string, unknown>;
    const type = String(rec.type ?? "UNKNOWN");
    const ledger = await deps.ledger.record({
      tenantId,
      customerId,
      actionType: "recommendation.triage",
      requestId: `rec-${tenantId}-${customerId}-${n}`,
      scope: `customers/${customerId}`,
      payload: { recommendation: rec },
      createdBy: "AUTOMATION",
    });
    await deps.findings.record({
      tenantId,
      customerId,
      kind: "recommendation",
      severity: "info",
      summary: `Google recommendation: ${type} (ledger ${ledger.id} awaiting triage)`,
      details: JSON.stringify(rec).slice(0, 1000),
      ledgerId: ledger.id,
    });
    n++;
  }
  return n;
}

export async function scanCustomer(deps: AuditDeps, tenantId: string, customerId: string, since: Date): Promise<ScanSummary> {
  const [drift, policy, recommendations] = await Promise.all([
    driftScan(deps, tenantId, customerId, since).catch(() => 0),
    policyScan(deps, tenantId, customerId).catch(() => 0),
    recommendationScan(deps, tenantId, customerId).catch(() => 0),
  ]);
  return { tenantId, customerId, drift, policy, recommendations };
}
