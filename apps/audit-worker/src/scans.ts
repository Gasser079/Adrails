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
  conversionLoss: number;
  impressionShare: number;
  uploadHealth: number;
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
  const [drift, policy, recommendations, conversionLoss, impressionShare, uploadHealth] = await Promise.all([
    driftScan(deps, tenantId, customerId, since).catch(() => 0),
    policyScan(deps, tenantId, customerId).catch(() => 0),
    recommendationScan(deps, tenantId, customerId).catch(() => 0),
    conversionLossScan(deps, tenantId, customerId, since).catch(() => 0),
    impressionShareScan(deps, tenantId, customerId).catch(() => 0),
    offlineUploadHealthScan(deps, tenantId, customerId).catch(() => 0),
  ]);
  return { tenantId, customerId, drift, policy, recommendations, conversionLoss, impressionShare, uploadHealth };
}

/**
 * Conversion-loss triage (ported from google-ads-api-account-diagnostics).
 * Compares recent vs prior window on conversions/value/cost, segmented by
 * date; flags drops. cost_micros is divided by 1,000,000 for currency.
 */
export async function conversionLossScan(deps: AuditDeps, tenantId: string, customerId: string, since: Date): Promise<number> {
  const from = gaqlDateTime(since).slice(0, 10);
  const query =
    `SELECT campaign.name, metrics.conversions, metrics.conversions_value, ` +
    `metrics.cost_micros, segments.date FROM campaign ` +
    `WHERE segments.date >= '${from}' ORDER BY segments.date DESC LIMIT 100`;
  const rows = (await deps.ads.searchGaql({ tenantId, customerId, query })) as GaqlRow[];
  if (!rows.length) return 0;
  const byDate = new Map<string, { conv: number; value: number; cost: number }>();
  for (const r of rows) {
    const m = (r.metrics ?? {}) as Record<string, number>;
    const s = (r.segments ?? {}) as Record<string, string>;
    const c = (r.campaign ?? {}) as Record<string, string>;
    const d = String(s.date ?? "unknown");
    const e = byDate.get(d) ?? { conv: 0, value: 0, cost: 0 };
    e.conv += Number(m.conversions ?? 0);
    e.value += Number(m.conversions_value ?? 0);
    e.cost += Number(m.cost_micros ?? 0) / 1_000_000;
    byDate.set(d, e);
    void c;
  }
  const days = [...byDate.entries()].sort(([a], [b]) => (a < b ? 1 : -1));
  if (days.length < 2) return 0;
  const [latestDate, latest] = days[0];
  const prior = days.slice(1).reduce((a, [, v]) => ({ conv: a.conv + v.conv, value: a.value + v.value, cost: a.cost + v.cost }), { conv: 0, value: 0, cost: 0 });
  const n = days.length - 1;
  const avgConv = prior.conv / n;
  if (avgConv > 0 && latest.conv < avgConv * 0.7) {
    const drop = Math.round((1 - latest.conv / avgConv) * 100);
    await deps.findings.record({
      tenantId,
      customerId,
      kind: "anomaly",
      severity: "warning",
      summary: `Conversion drop on ${latestDate}: ${latest.conv} vs ~${avgConv.toFixed(1)}/day prior avg (-${drop}%)`,
      details: JSON.stringify({ latestDate, latest, priorAvg: { conv: avgConv, value: prior.value / n, cost: prior.cost / n } }).slice(0, 1000),
    });
    return 1;
  }
  return 0;
}

/**
 * Impression-share opportunity classification (ported from diagnostics skill).
 * Budget-lost vs rank-lost tells the owner which lever to pull. Values are
 * decimals (0.35 = 35%) or strings like "< 0.10".
 */
export async function impressionShareScan(deps: AuditDeps, tenantId: string, customerId: string): Promise<number> {
  const query =
    `SELECT campaign.name, metrics.search_impression_share, ` +
    `metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share ` +
    `FROM campaign LIMIT 100`;
  const rows = (await deps.ads.searchGaql({ tenantId, customerId, query })) as GaqlRow[];
  const num = (v: unknown): number => {
    if (typeof v === "number") return v;
    const m = /([0-9]*\.?[0-9]+)/.exec(String(v ?? ""));
    return m ? Number(m[1]) : 0;
  };
  let n = 0;
  for (const r of rows) {
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    const c = (r.campaign ?? {}) as Record<string, string>;
    const budgetLost = num(m.search_budget_lost_impression_share);
    const rankLost = num(m.search_rank_lost_impression_share);
    if (budgetLost >= 0.2 || rankLost >= 0.2) {
      const lever = budgetLost >= rankLost ? "budget (raise caps or reallocate)" : "rank (bids/quality)";
      await deps.findings.record({
        tenantId,
        customerId,
        kind: "anomaly",
        severity: budgetLost >= 0.2 && rankLost >= 0.2 ? "warning" : "info",
        summary: `Impression share loss on ${String(c.name ?? "campaign")}: budget-lost ${(budgetLost * 100).toFixed(0)}%, rank-lost ${(rankLost * 100).toFixed(0)}% — lever: ${lever}`,
        details: JSON.stringify({ campaign: c.name, budgetLost, rankLost }).slice(0, 500),
      });
      n++;
    }
  }
  return n;
}

/**
 * Offline upload pipeline health (ported from diagnostics skill).
 * Stop rule: empty summary = no uploads configured — report once, do not retry.
 */
export async function offlineUploadHealthScan(deps: AuditDeps, tenantId: string, customerId: string): Promise<number> {
  const query =
    `SELECT offline_conversion_upload_conversion_action_summary.conversion_action_name, ` +
    `offline_conversion_upload_conversion_action_summary.successful_event_count, ` +
    `offline_conversion_upload_conversion_action_summary.total_event_count, ` +
    `offline_conversion_upload_conversion_action_summary.status ` +
    `FROM offline_conversion_upload_conversion_action_summary LIMIT 50`;
  const rows = (await deps.ads.searchGaql({ tenantId, customerId, query })) as GaqlRow[];
  if (!rows.length) {
    await deps.findings.record({
      tenantId,
      customerId,
      kind: "anomaly",
      severity: "info",
      summary: "No offline conversion uploads configured for this account",
      details: "upload summary empty — nothing to diagnose, not retried",
    });
    return 1;
  }
  let n = 0;
  for (const r of rows) {
    const s = (r.offline_conversion_upload_conversion_action_summary ?? r) as Record<string, unknown>;
    const ok = Number(s.successful_event_count ?? 0);
    const total = Number(s.total_event_count ?? 0);
    if (total > 0 && ok < total) {
      await deps.findings.record({
        tenantId,
        customerId,
        kind: "anomaly",
        severity: "warning",
        summary: `Upload shortfall on ${String(s.conversion_action_name ?? "action")}: ${ok}/${total} succeeded (status ${String(s.status ?? "?")})`,
        details: JSON.stringify(s).slice(0, 500),
      });
      n++;
    }
  }
  return n;
}
