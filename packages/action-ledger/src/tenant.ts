// @adrails/action-ledger/tenant — tenant OAuth metadata (non-secret) +
// managed client registry. Mirrors the MCC connection: one tenant row holds
// the manager login_customer_id; managed_clients holds every discovered client.
import { CustomerIdSchema } from "@adrails/shared-types";
import type { D1Like } from "./repository.js";

export interface TenantMeta {
  tenantId: string;
  loginCustomerId: string;
  accountEmail?: string;
  scopes: string;
  projectId?: string;
  tokenSource: string;
}

export interface ManagedClient {
  tenantId: string;
  customerId: string;
  resourceName: string;
}

const digits = (label: string, v: string): string => CustomerIdSchema.parse(v);

export class TenantRepository {
  constructor(private readonly db: D1Like, private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  public async upsertTenant(meta: TenantMeta): Promise<void> {
    digits("loginCustomerId", meta.loginCustomerId);
    await this.db
      .prepare(
        `INSERT INTO oauth_meta (tenant_id, login_customer_id, account_email, scopes, project_id, token_source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id) DO UPDATE SET
           login_customer_id = excluded.login_customer_id,
           account_email = excluded.account_email,
           scopes = excluded.scopes,
           project_id = excluded.project_id,
           token_source = excluded.token_source,
           updated_at = excluded.updated_at`,
      )
      .bind(meta.tenantId, meta.loginCustomerId, meta.accountEmail ?? null, meta.scopes, meta.projectId ?? null, meta.tokenSource, this.now())
      .run();
  }

  public async getTenant(tenantId: string): Promise<TenantMeta | null> {
    const row = await this.db.prepare(`SELECT * FROM oauth_meta WHERE tenant_id = ?`).bind(tenantId).first<Record<string, unknown>>();
    if (!row) return null;
    return {
      tenantId: String(row.tenant_id),
      loginCustomerId: String(row.login_customer_id),
      accountEmail: row.account_email == null ? undefined : String(row.account_email),
      scopes: String(row.scopes),
      projectId: row.project_id == null ? undefined : String(row.project_id),
      tokenSource: String(row.token_source),
    };
  }

  /** Replace the client's discovered set (discovery is authoritative per run). */
  public async replaceClients(tenantId: string, clients: Array<{ customerId: string; resourceName: string }>): Promise<number> {
    const ts = this.now();
    await this.db.prepare(`DELETE FROM managed_clients WHERE tenant_id = ?`).bind(tenantId).run();
    for (const c of clients) {
      digits("customerId", c.customerId);
      await this.db
        .prepare(`INSERT INTO managed_clients (tenant_id, customer_id, resource_name, discovered_at) VALUES (?, ?, ?, ?)`)
        .bind(tenantId, c.customerId, c.resourceName, ts)
        .run();
    }
    return clients.length;
  }

  public async listTenants(): Promise<TenantMeta[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM oauth_meta ORDER BY tenant_id`)
      .bind()
      .all<Record<string, unknown>>();
    return results.map((row: Record<string, unknown>) => ({
      tenantId: String(row.tenant_id),
      loginCustomerId: String(row.login_customer_id),
      accountEmail: row.account_email == null ? undefined : String(row.account_email),
      scopes: String(row.scopes),
      projectId: row.project_id == null ? undefined : String(row.project_id),
      tokenSource: String(row.token_source),
    }));
  }

  public async listClients(tenantId: string): Promise<ManagedClient[]> {    const { results } = await this.db
      .prepare(`SELECT tenant_id, customer_id, resource_name FROM managed_clients WHERE tenant_id = ? ORDER BY customer_id`)
      .bind(tenantId)
      .all<Record<string, unknown>>();
    return results.map((r) => ({
      tenantId: String(r.tenant_id),
      customerId: String(r.customer_id),
      resourceName: String(r.resource_name),
    }));
  }
}
