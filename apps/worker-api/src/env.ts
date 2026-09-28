// @adrails/worker-api/env — Worker bindings + dependency construction.
// Secrets (refresh tokens, dev creds) arrive as Worker Secrets — never D1 plaintext.
import type { D1Database, KVNamespace, Queue } from "@cloudflare/workers-types";
import { EnvGoogleAdsCredentialProvider } from "@adrails/ads-client";
import { GoogleAdsRestClient } from "@adrails/ads-client";
import { ActionLedgerRepository, TenantRepository, type D1Like } from "@adrails/action-ledger";

export interface AdrailsEnv {
  LEDGER_DB: D1Database;
  CACHE: KVNamespace;
  EXECUTION_QUEUE: Queue;
  ADRAILS_API_VERSION?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
  GOOGLE_ADS_CUSTOMER_ID?: string;
  GOOGLE_ADS_LOGIN_CUSTOMER_ID?: string;
}

export interface AdrailsDeps {
  ledger: ActionLedgerRepository;
  tenant: TenantRepository;
  ads: GoogleAdsRestClient;
}

export function buildDeps(env: AdrailsEnv): AdrailsDeps {
  const provider = new EnvGoogleAdsCredentialProvider();
  return {
    ledger: new ActionLedgerRepository(env.LEDGER_DB as unknown as D1Like),
    tenant: new TenantRepository(env.LEDGER_DB as unknown as D1Like),
    ads: new GoogleAdsRestClient({
      authProvider: provider,
      kv: env.CACHE as unknown as { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> },
    }),
  };
}
