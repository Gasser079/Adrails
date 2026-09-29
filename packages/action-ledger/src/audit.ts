// @adrails/action-ledger/audit — append-only audit findings (L3).
// The audit worker records observations here; triage happens via the ledger.
import type { D1Like } from "./repository.js";

export type FindingKind = "drift" | "policy" | "anomaly" | "recommendation";
export type FindingSeverity = "info" | "warning" | "critical";

export interface AuditFinding {
  id: string;
  tenantId: string;
  customerId: string;
  kind: FindingKind;
  severity: FindingSeverity;
  summary: string;
  details?: string;
  ledgerId?: string;
}

export class AuditFindingsRepository {
  constructor(private readonly db: D1Like, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  public async record(f: Omit<AuditFinding, "id"> & { id?: string }): Promise<AuditFinding> {
    const id = f.id ?? `finding-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await this.db
      .prepare(
        `INSERT INTO audit_findings (id, tenant_id, customer_id, kind, severity, summary, details, ledger_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, f.tenantId, f.customerId, f.kind, f.severity, f.summary, f.details ?? null, f.ledgerId ?? null, this.now())
      .run();
    return { ...f, id };
  }

  public async listByTenant(tenantId: string, limit = 100): Promise<AuditFinding[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM audit_findings WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`)
      .bind(tenantId, limit)
      .all<Record<string, unknown>>();
    return results.map((r) => ({
      id: String(r.id),
      tenantId: String(r.tenant_id),
      customerId: String(r.customer_id),
      kind: r.kind as FindingKind,
      severity: r.severity as FindingSeverity,
      summary: String(r.summary),
      details: r.details == null ? undefined : String(r.details),
      ledgerId: r.ledger_id == null ? undefined : String(r.ledger_id),
    }));
  }
}
