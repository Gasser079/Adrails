// @adrails/ads-client/file-credentials — runtime loader for an existing OAuth
// credential set on disk (e.g. the periphery/connectors token files belonging
// to the agency's manager login). Read-only by default: the loader never writes
// the user's files. Refresh is on-demand (see token-service).
import fs from "node:fs";
import path from "node:path";
import { GoogleAdsAuthContextSchema, type GoogleAdsAuthContext } from "@adrails/shared-types";
import type { GoogleAdsCredentialProvider } from "./auth.js";
import { refreshAccessToken } from "./auth.js";
import type { KvLike } from "./rate.js";

interface TokenFile {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  scope?: string;
}

interface ClientSecretFile {
  installed?: {
    client_id?: string;
    client_secret?: string;
    project_id?: string;
  };
  web?: {
    client_id?: string;
    client_secret?: string;
    project_id?: string;
  };
}

export interface FileCredentialOptions {
  /** Directory holding google-ads-token.json + google-ads-client-secret.json */
  dir: string;
  tokenFile?: string;
  secretFile?: string;
  customerId: string;
  loginCustomerId: string;
  /** Skew before expiry at which the access token is refreshed. Default 60s. */
  refreshSkewMs?: number;
  kv?: KvLike | null;
  fetchFn?: typeof fetch;
}

const readJson = (p: string): unknown => JSON.parse(fs.readFileSync(p, "utf8"));

export class FileCredentialProvider implements GoogleAdsCredentialProvider {
  private memory: { accessToken: string; expiresAtMs: number } | null = null;
  constructor(private readonly opts: FileCredentialOptions) {}

  private tokenPath(): string {
    return path.join(this.opts.dir, this.opts.tokenFile ?? "google-ads-token.json");
  }
  private secretPath(): string {
    return path.join(this.opts.dir, this.opts.secretFile ?? "google-ads-client-secret.json");
  }

  public async getAuthContext(tenantId: string): Promise<GoogleAdsAuthContext> {
    const skew = this.opts.refreshSkewMs ?? 60_000;
    const secretDoc = readJson(this.secretPath()) as ClientSecretFile;
    const secret = secretDoc.web ?? secretDoc.installed;
    const clientId = secret?.client_id;
    const clientSecret = secret?.client_secret;
    if (!clientId || !clientSecret) throw new Error("file_credentials_missing_client (client-secret file unreadable)");
    const file = readJson(this.tokenPath()) as TokenFile;
    if (!file.refresh_token) throw new Error("file_credentials_missing_refresh_token");

    const now = Date.now();
    if (this.memory && this.memory.expiresAtMs - now > skew) {
      return this.context(clientId, clientSecret, file.refresh_token, this.memory.accessToken);
    }
    if (this.opts.kv) {
      const cached = await this.opts.kv.get(`adrails:token:${tenantId}`).catch(() => null);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as { accessToken: string; expiresAtMs: number };
          if (parsed.expiresAtMs - now > skew) {
            this.memory = parsed;
            return this.context(clientId, clientSecret, file.refresh_token, parsed.accessToken);
          }
        } catch { /* fall through to file/refresh */ }
      }
    }
    if (file.access_token && (file.expiry_date ?? 0) - now > skew) {
      this.memory = { accessToken: file.access_token, expiresAtMs: file.expiry_date ?? now };
      return this.context(clientId, clientSecret, file.refresh_token, file.access_token);
    }

    // Stale or missing access token → refresh via Google (refresh token itself never leaves this path).
    let bundle;
    try {
      bundle = await refreshAccessToken({
        fetchFn: this.opts.fetchFn ?? fetch,
        clientId,
        clientSecret,
        refreshToken: file.refresh_token,
      });
    } catch (err) {
      throw new Error(
        `oauth_refresh_failed: the stored refresh token was rejected (invalid_grant usually means revoked/expired). ` +
        `Fix: one fresh OAuth consent for the manager login, then replace the token file. Cause: ${(err as Error)?.message ?? err}`,
      );
    }
    this.memory = { accessToken: bundle.accessToken, expiresAtMs: bundle.expiresAtMs };
    if (this.opts.kv) {
      await this.opts.kv
        .put(`adrails:token:${tenantId}`, JSON.stringify(this.memory), { expirationTtl: 3500 })
        .catch(() => {});
    }
    return this.context(clientId, clientSecret, file.refresh_token, bundle.accessToken);
  }

  private context(clientId: string, clientSecret: string, refreshToken: string, accessToken: string): GoogleAdsAuthContext {
    return GoogleAdsAuthContextSchema.parse({
      clientId,
      clientSecret,
      refreshToken,
      accessToken,
      customerId: this.opts.customerId,
      loginCustomerId: this.opts.loginCustomerId,
    });
  }
}
