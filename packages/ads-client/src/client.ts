// @adrails/ads-client/client — REST Google Ads client (v25).
// Transport: fetch (Workers-native). Dual-ID on every call; the ONLY exception
// is listAccessibleCustomers (raw OAuth, no login-customer-id).
import { buildAdsHeaders, assertCustomerId } from "./headers.js";
import { ENDPOINTS } from "./endpoints.js";
import { GoogleAdsErrorMapper, AdsApiError } from "./errors.js";
import { retryWithBackoff, PerCustomerGate, KvResponseCache, type KvLike } from "./rate.js";
import type { GoogleAdsCredentialProvider } from "./auth.js";
import { refreshAccessToken } from "./auth.js";

export interface RestClientDeps {
  fetchFn?: typeof fetch;
  authProvider: GoogleAdsCredentialProvider;
  kv?: KvLike | null;
  cacheTtlSeconds?: number;
}

export interface GaqlSearchInput {
  tenantId: string;
  customerId: string;
  query: string;
  pageSize?: number;
  validateOnly?: boolean;
}

export class GoogleAdsRestClient {
  private readonly fetchFn: typeof fetch;
  private readonly gate = new PerCustomerGate();
  private readonly cache: KvResponseCache;
  private readonly cacheTtl: number;

  constructor(private readonly deps: RestClientDeps) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.cache = new KvResponseCache(deps.kv ?? null);
    this.cacheTtl = deps.cacheTtlSeconds ?? 3600;
  }

  private async tokenFor(tenantId: string): Promise<{ accessToken: string; loginCustomerId?: string }> {
    const auth = await this.deps.authProvider.getAuthContext(tenantId);
    if (auth.accessToken) return { accessToken: auth.accessToken, loginCustomerId: auth.loginCustomerId };
    // No live access token (e.g. Worker Secrets hold only the refresh triple):
    // mint one now, cache it in KV so concurrent calls share it.
    if (!auth.clientId || !auth.clientSecret || !auth.refreshToken) {
      throw new Error(`auth_missing_access_token for tenant ${tenantId} (refresh via Worker Secrets first)`);
    }
    const cacheKey = `adrails:token:${tenantId}`;
    const cached = await this.cache.get<{ accessToken: string; expiresAtMs: number }>(cacheKey);
    if (cached && cached.expiresAtMs - Date.now() > 60_000) {
      return { accessToken: cached.accessToken, loginCustomerId: auth.loginCustomerId };
    }
    const bundle = await refreshAccessToken({
      fetchFn: this.fetchFn,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      refreshToken: auth.refreshToken,
    });
    await this.cache.put(cacheKey, { accessToken: bundle.accessToken, expiresAtMs: bundle.expiresAtMs }, 3500);
    return { accessToken: bundle.accessToken, loginCustomerId: auth.loginCustomerId };
  }

  private async send<T>(opts: {
    url: string;
    method: "GET" | "POST";
    body?: unknown;
    tenantId: string;
    customerId: string;
    capabilityId: string;
    signal?: AbortSignal;
    useLoginHeader: boolean;
  }): Promise<T> {
    const { accessToken, loginCustomerId } = await this.tokenFor(opts.tenantId);
    const headers = buildAdsHeaders({
      accessToken,
      customerId: assertCustomerId(opts.customerId),
      loginCustomerId: opts.useLoginHeader ? loginCustomerId : undefined,
    });
    const doFetch = async (): Promise<T> => {
      const res = await this.fetchFn(opts.url, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
      });
      if (!res.ok) {
        const payload = await res.text().catch(() => "");
        let parsed: unknown = null;
        try { parsed = JSON.parse(payload); } catch { /* keep raw */ }
        throw { name: "GoogleAdsRestError", code: res.status, message: `Google Ads REST ${res.status}: ${payload.slice(0, 400)}`, errors: (parsed as { error?: { details?: Array<{ message?: string; errorCode?: Record<string, string> }> } })?.error?.details ?? [] };
      }
      return (await res.json()) as T;
    };
    try {
      return await retryWithBackoff(doFetch, {
        shouldRetry: (err) => GoogleAdsErrorMapper.mapError(err, { capabilityId: opts.capabilityId }).retryable,
      });
    } catch (err) {
      throw new AdsApiError(GoogleAdsErrorMapper.mapError(err, { capabilityId: opts.capabilityId }));
    }
  }

  /** EXCEPTION endpoint — onboarding/discovery loop. Omits login-customer-id. */
  public async listAccessibleCustomers(tenantId: string, signal?: AbortSignal): Promise<string[]> {
    const json = await this.send<{ resourceNames?: string[] }>({
      url: ENDPOINTS.listAccessibleCustomers(),
      method: "GET",
      tenantId,
      customerId: (await this.deps.authProvider.getAuthContext(tenantId)).customerId,
      capabilityId: "account_discovery",
      signal,
      useLoginHeader: false,
    });
    return json.resourceNames ?? [];
  }

  /** GAQL search (Strategy L1 read-only). */
  public async searchGaql(input: GaqlSearchInput, signal?: AbortSignal): Promise<unknown[]> {
    const key = this.cache.key(["gaql", input.tenantId, input.customerId, input.query, input.pageSize ?? 100]);
    const hit = await this.cache.get<{ results?: unknown[] }>(key);
    if (hit) return hit.results ?? [];
    const json = await this.send<{ results?: unknown[] }>({
      url: ENDPOINTS.gaussian.search(input.customerId),
      method: "POST",
      body: { query: input.query, pageSize: input.pageSize ?? 100 },
      tenantId: input.tenantId,
      customerId: input.customerId,
      capabilityId: "gaql_search",
      signal,
      useLoginHeader: true,
    });
    await this.cache.put(key, json, this.cacheTtl);
    return json.results ?? [];
  }

  /** Atomic mutate (Execution L2 — only ever called from the dispatched ledger path). */
  public async mutate(tenantId: string, customerId: string, mutateOperations: unknown[], signal?: AbortSignal): Promise<unknown> {
    return this.send({
      url: ENDPOINTS.gaussian.mutate(customerId),
      method: "POST",
      body: { mutate_operations: mutateOperations },
      tenantId,
      customerId,
      capabilityId: "google_ads_mutate",
      signal,
      useLoginHeader: true,
    });
  }

  /** Keyword Planning reads (Strategy L1). Serialized 1-QPS per customer. */
  public async generateKeywordIdeas(tenantId: string, customerId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.gate.run(customerId, () => this.send({
      url: ENDPOINTS.plans.ideas(customerId),
      method: "POST",
      body,
      tenantId,
      customerId,
      capabilityId: "search_volume_discovery",
      signal,
      useLoginHeader: true,
    }));
  }

  public async uploadClickConversions(tenantId: string, customerId: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return this.send({
      url: ENDPOINTS.conversions.uploadClicks(customerId),
      method: "POST",
      body,
      tenantId,
      customerId,
      capabilityId: "conversion_upload",
      signal,
      useLoginHeader: true,
    });
  }
}
