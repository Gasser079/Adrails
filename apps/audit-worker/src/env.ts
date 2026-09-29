// @adrails/audit-worker/env — read-only watchdog bindings (no queue, no mutator).
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { EnvGoogleAdsCredentialProvider, GoogleAdsRestClient } from "@adrails/ads-client";
import { ActionLedgerRepository, TenantRepository, AuditFindingsRepository, type D1Like } from "@adrails/action-ledger";

export interface AuditEnv {
  LEDGER_DB: D1Database;
  CACHE: KVNamespace;
}

export interface AuditDeps {
  ledger: ActionLedgerRepository;
  tenant: TenantRepository;
  findings: AuditFindingsRepository;
  ads: GoogleAdsRestClient;
}

export function buildAuditDeps(env: AuditEnv): AuditDeps {
  const db = env.LEDGER_DB as unknown as D1Like;
  const kv = env.CACHE as unknown as { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> };
  return {
    ledger: new ActionLedgerRepository(db),
    tenant: new TenantRepository(db),
    findings: new AuditFindingsRepository(db),
    ads: new GoogleAdsRestClient({ authProvider: new EnvGoogleAdsCredentialProvider(), kv }),
  };
}
