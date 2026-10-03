// @adrails/action-ledger/repository — D1-backed ledger over a minimal D1Like
// port (real env.LEDGER_DB in Workers; node:sqlite adapter in tests).
import { ActionStatusSchema, type ActionProposal, type ActionStatus, type RiskTier } from "@adrails/shared-types";
import { canTransition, evaluateRisk } from "./transitions.js";

export interface D1Row {
  [k: string]: unknown;
}

export interface D1Prepared {
  bind(...values: unknown[]): D1Bound;
}

export interface D1Bound {
  run(): Promise<unknown>;
  first<T = D1Row>(): Promise<T | null>;
  all<T = D1Row>(): Promise<{ results: T[] }>;
}

export interface D1Like {
  prepare(sql: string): D1Prepared;
}

export interface ProposalInput {
  tenantId: string;
  customerId: string;
  actionType: string;
  requestId: string;
  scope: string;
  payload: unknown;
  payloadSchemaVersion?: number;
  createdBy: ActionProposal["createdBy"];
  id?: string;
  idempotencyKey?: string;
  apiEndpoint?: string;
}

export interface LedgerRecord extends ActionProposal {
  policyResult?: string;
  error?: string;
}

const rowToRecord = (r: D1Row): LedgerRecord => ({
  id: String(r.id),
  tenantId: String(r.tenant_id),
  customerId: String(r.customer_id),
  entityType: String(r.action_type).split(".")[0] ?? String(r.action_type),
  actionType: String(r.action_type),
  payload: JSON.parse(String(r.payload)),
  riskScore: Number(r.risk_score),
  riskTier: (r.risk_tier as LedgerRecord["riskTier"]),
  status: ActionStatusSchema.parse(r.status),
  createdBy: (r.requested_by as LedgerRecord["createdBy"]),
  createdAt: new Date(Number(r.created_at) * 1000).toISOString(),
});

export class ActionLedgerRepository {
  constructor(private readonly db: D1Like, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  private uid(): string {
    return `ledger-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  public async record(input: ProposalInput, opts?: { risk?: { score: number; tier: RiskTier } }): Promise<LedgerRecord> {
    const evaluated = opts?.risk ?? evaluateRisk(input.actionType);
    const score = evaluated.score;
    const tier = evaluated.tier;
    const id = input.id ?? this.uid();
    const ts = this.now();
    await this.db
      .prepare(
        `INSERT INTO action_ledger (id, tenant_id, customer_id, action_type, request_id, scope, payload, payload_schema_version, status, risk_score, risk_tier, requested_by, idempotency_key, api_endpoint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, input.tenantId, input.customerId, input.actionType, input.requestId, input.scope,
        JSON.stringify(input.payload), input.payloadSchemaVersion ?? 1, score, tier,
        input.createdBy, input.idempotencyKey ?? null, input.apiEndpoint ?? null, ts, ts,
      )
      .run();
    await this.appendEvent(id, null, "PROPOSED", input.createdBy, "recorded");
    const rec = await this.getById(id);
    if (!rec) throw new Error(`ledger invariant violated: ${id} not found after insert`);
    return rec;
  }

  public async getById(id: string): Promise<LedgerRecord | null> {
    const row = await this.db.prepare(`SELECT * FROM action_ledger WHERE id = ?`).bind(id).first<D1Row>();
    return row ? rowToRecord(row) : null;
  }

  public async pendingByTenant(tenantId: string, limit = 50): Promise<LedgerRecord[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM action_ledger WHERE tenant_id = ? AND status IN ('PROPOSED','VALIDATED') ORDER BY created_at DESC LIMIT ?`)
      .bind(tenantId, limit)
      .all<D1Row>();
    return results.map(rowToRecord);
  }

  public async transition(id: string, to: ActionStatus, actor: string, note?: string, error?: string): Promise<LedgerRecord> {
    const cur = await this.getById(id);
    if (!cur) throw new Error(`ledger ${id} not found`);
    if (!canTransition(cur.status, to)) {
      throw new Error(`illegal_ledger_transition: ${cur.status} -> ${to}`);
    }
    const ts = this.now();
    await this.db
      .prepare(`UPDATE action_ledger SET status = ?, updated_at = ?, error = COALESCE(?, error) WHERE id = ?`)
      .bind(to, ts, error ?? null, id)
      .run();
    await this.appendEvent(id, cur.status, to, actor, note);
    const next = await this.getById(id);
    if (!next) throw new Error(`ledger invariant violated: ${id} missing after transition`);
    return next;
  }

  private async appendEvent(ledgerId: string, from: ActionStatus | null, to: ActionStatus | string, actor: string, note?: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO ledger_events (ledger_id, from_status, to_status, actor, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(ledgerId, from, to, actor, note ?? null, this.now())
      .run();
  }
}
