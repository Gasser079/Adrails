import test from "node:test";
import assert from "node:assert";
import { GoogleAdsRestClient } from "../client.js";
import type { GoogleAdsCredentialProvider } from "../auth.js";

const provider: GoogleAdsCredentialProvider = {
  getAuthContext: async () => ({
    accessToken: "tok",
    loginCustomerId: "1112223333",
    customerId: "4445556666",
  }),
};

function mockFetch(log: Array<{ url: string; headers: Record<string, string>; body?: string }>, script: Array<{ status: number; json?: unknown; text?: string }>): typeof fetch {
  let i = 0;
  return (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
    const step = script[Math.min(i++, script.length - 1)];
    log.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body });
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.json ?? {},
      text: async () => step.text ?? JSON.stringify(step.json ?? {}),
    } as unknown as Response;
  }) as typeof fetch;
}

test("discovery exception: listAccessibleCustomers omits login-customer-id", async () => {
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = new GoogleAdsRestClient({ fetchFn: mockFetch(log, [{ status: 200, json: { resourceNames: ["customers/1"] } }]), authProvider: provider });
  const names = await client.listAccessibleCustomers("t1");
  assert.deepStrictEqual(names, ["customers/1"]);
  assert.ok(log[0].url.includes("customers:listAccessibleCustomers"));
  assert.ok(!("login-customer-id" in log[0].headers), "exception endpoint must omit the login header");
});

test("dual-ID enforced: mutates carry login-customer-id + path customer", async () => {
  const log: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const client = new GoogleAdsRestClient({ fetchFn: mockFetch(log, [{ status: 200, json: { mutateOperationResponses: [] } }]), authProvider: provider });
  await client.mutate("t1", "4445556666", [{ op: 1 }]);
  assert.ok(log[0].url.includes("customers/4445556666:googleAds:mutate"));
  assert.strictEqual(log[0].headers["login-customer-id"], "1112223333");
});

test("tokenFor: mints + caches access token when provider holds only the refresh triple", async () => {
  const calls: string[] = [];
  const fetchFn = (async (url: unknown, init?: { body?: string }) => {
    calls.push(String(url));
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return { ok: true, status: 200, json: async () => ({ access_token: "minted-at", expires_in: 3600 }), text: async () => "{}" };
    }
    return { ok: true, status: 200, json: async () => ({ results: [{ x: 1 }] }), text: async () => "{}" };
  }) as unknown as typeof fetch;
  const store = new Map<string, string>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
  };
  const noLiveToken: GoogleAdsCredentialProvider = {
    getAuthContext: async () => ({ customerId: "4445556666", loginCustomerId: "1112223333", clientId: "cid", clientSecret: "csec", refreshToken: "rt" }),
  };
  const client = new GoogleAdsRestClient({ fetchFn, authProvider: noLiveToken, kv });
  const rows = await client.searchGaql({ tenantId: "t1", customerId: "4445556666", query: "SELECT 1" });
  assert.strictEqual(rows.length, 1);
  assert.ok(calls[0].includes("oauth2.googleapis.com/token"), "refresh happens before the API call");
  assert.ok(store.has("adrails:token:t1"), "minted token cached in KV");
  const before = calls.length;
  await client.searchGaql({ tenantId: "t1", customerId: "4445556666", query: "SELECT 2" });
  assert.ok(!calls.slice(before).some((u) => u.includes("oauth2.googleapis.com/token")), "second call reuses cached token, no re-refresh");
});

test("transient 429 retries and 401 surfaces ACCESS-classified failure, dashes rejected", async () => {
  const log: Array<{ url: string; headers: Record<string, string> }> = [];
  const client = new GoogleAdsRestClient({
    fetchFn: mockFetch(log, [
      { status: 429, json: { error: { details: [{ message: "slow down", errorCode: { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" } }] } } },
      { status: 200, json: { results: [{ x: 1 }] } },
    ]),
    authProvider: provider,
  });
  const rows = await client.searchGaql({ tenantId: "t1", customerId: "4445556666", query: "SELECT 1" });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(log.length, 2, "429 must be retried once");

  const log2: Array<{ url: string; headers: Record<string, string> }> = [];
  const unauth = new GoogleAdsRestClient({
    fetchFn: mockFetch(log2, [{ status: 401, json: { error: {} } }]),
    authProvider: provider,
  });
  await assert.rejects(unauth.searchGaql({ tenantId: "t1", customerId: "4445556666", query: "SELECT 1" }), /AUTHENTICATION/);

  await assert.rejects(client.searchGaql({ tenantId: "t1", customerId: "44-45", query: "SELECT 1" }), /digits/i);
});
