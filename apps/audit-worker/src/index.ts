// @adrails/audit-worker — scheduled watchdog (every 30 min).
// For every known tenant and managed client: drift + policy + recommendation
// scans. Read-only against Google; writes go to findings + ledger proposals.
import { buildAuditDeps, type AuditEnv, type AuditDeps } from "./env.js";
import { scanCustomer, type ScanSummary } from "./scans.js";

export async function runAudit(deps: AuditDeps, since: Date): Promise<ScanSummary[]> {
  const out: ScanSummary[] = [];
  const tenants = await deps.tenant.listTenants();
  for (const t of tenants) {
    const clients = await deps.tenant.listClients(t.tenantId);
    for (const c of clients) {
      try {
        out.push(await scanCustomer(deps, t.tenantId, c.customerId, since));
      } catch (err) {
        console.error(`audit failed for ${t.tenantId}/${c.customerId}:`, err);
      }
    }
  }
  return out;
}

export default {
  async scheduled(_event: unknown, env: AuditEnv): Promise<void> {
    const since = new Date(Date.now() - 30 * 60 * 1000);
    const summary = await runAudit(buildAuditDeps(env), since);
    console.log(`audit complete: ${summary.length} customer scans`, JSON.stringify(summary));
  },
};
