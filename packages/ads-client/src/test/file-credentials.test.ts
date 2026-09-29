import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileCredentialProvider } from "../file-credentials.js";

// All credential values below are obvious fakes for fixtures â€” never real secrets.
function fixtureDir(token: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adrails-cred-"));
  fs.writeFileSync(
    path.join(dir, "google-ads-client-secret.json"),
    JSON.stringify({ installed: { client_id: "fake-client-id", client_secret: "fake-secret", project_id: "fake-project" } }),
  );
  fs.writeFileSync(path.join(dir, "google-ads-token.json"), JSON.stringify(token));
  return dir;
}

test("file provider: fresh file token passes through untouched", async () => {
  const dir = fixtureDir({ access_token: "fresh-at", refresh_token: "rt", expiry_date: Date.now() + 3_600_000 });
  try {
    const p = new FileCredentialProvider({ dir, customerId: "111", loginCustomerId: "1000000001" });
    const ctx = await p.getAuthContext("agency");
    assert.strictEqual(ctx.accessToken, "fresh-at");
    assert.strictEqual(ctx.customerId, "111");
    assert.strictEqual(ctx.loginCustomerId, "1000000001");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("file provider: stale access token triggers exactly one refresh", async () => {
  const dir = fixtureDir({ access_token: "stale-at", refresh_token: "rt", expiry_date: Date.now() - 1000 });
  let refreshCalls = 0;
  const fetchFn = (async () => {
    refreshCalls++;
    return { ok: true, status: 200, json: async () => ({ access_token: "new-at", expires_in: 3600 }) };
  }) as unknown as typeof fetch;
  try {
    const p = new FileCredentialProvider({ dir, customerId: "111", loginCustomerId: "1000000001", fetchFn });
    const ctx = await p.getAuthContext("agency");
    assert.strictEqual(ctx.accessToken, "new-at");
    assert.strictEqual(refreshCalls, 1);
    // second call reuses memory cache â€” no second refresh
    await p.getAuthContext("agency");
    assert.strictEqual(refreshCalls, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("file provider: rejected refresh surfaces the consent-fix guidance, not a raw error", async () => {
  const dir = fixtureDir({ access_token: "stale-at", refresh_token: "rt", expiry_date: 1 });
  const fetchFn = (async () => ({ ok: false, status: 400, text: async () => "invalid_grant" })) as unknown as typeof fetch;
  try {
    const p = new FileCredentialProvider({ dir, customerId: "111", loginCustomerId: "1000000001", fetchFn });
    await assert.rejects(p.getAuthContext("agency"), /fresh OAuth consent/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
