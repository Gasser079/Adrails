// @adrails/worker-execution/env — the sole mutator in the system.
// It never proposes and never approves: it only executes DISPATCHED rows.
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { EnvGoogleAdsCredentialProvider, GoogleAdsRestClient } from "@adrails/ads-client";
import { ActionLedgerRepository, type D1Like } from "@adrails/action-ledger";

export interface ExecutionEnv {
  LEDGER_DB: D1Database;
  CACHE: KVNamespace;
}

export interface ExecutionDeps {
  ledger: ActionLedgerRepository;
  ads: GoogleAdsRestClient;
}

export function buildExecutionDeps(env: ExecutionEnv): ExecutionDeps {
  return {
    ledger: new ActionLedgerRepository(env.LEDGER_DB as unknown as D1Like),
    ads: new GoogleAdsRestClient({
      authProvider: new EnvGoogleAdsCredentialProvider(),
      kv: env.CACHE as unknown as { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> },
    }),
  };
}
