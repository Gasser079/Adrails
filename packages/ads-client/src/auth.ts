// @adrails/ads-client/auth — OAuth2 user-auth flow per tenant (cloned compass).
// Developer tokens were sunset 2026-09-09: access lives on the Google Cloud
// project that owns the OAuth client. Adrails never sends a developer token.
import { GoogleAdsAuthContext, GoogleAdsAuthContextSchema } from "@adrails/shared-types";

export type { GoogleAdsAuthContext };

export interface GoogleAdsCredentialProvider {
  getAuthContext(tenantId: string): Promise<GoogleAdsAuthContext>;
}

/**
 * Env-backed provider (dev/seed use only). Maps per-tenant env vars with a
 * global fallback — same shape the Khora broker connector proved.
 */
export class EnvGoogleAdsCredentialProvider implements GoogleAdsCredentialProvider {
  public async getAuthContext(tenantId: string): Promise<GoogleAdsAuthContext> {
    const customerId = process.env[`GOOGLE_ADS_CUSTOMER_ID_${tenantId}`] ?? process.env.GOOGLE_ADS_CUSTOMER_ID;
    if (!customerId) throw new Error(`Missing GOOGLE_ADS_CUSTOMER_ID for tenant ${tenantId}`);
    const auth = {
      clientId: process.env.GOOGLE_ADS_CLIENT_ID,
      clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refreshToken: process.env[`GOOGLE_ADS_REFRESH_TOKEN_${tenantId}`] ?? process.env.GOOGLE_ADS_REFRESH_TOKEN,
      accessToken: process.env[`GOOGLE_ADS_ACCESS_TOKEN_${tenantId}`],
      customerId,
      loginCustomerId: process.env[`GOOGLE_ADS_LOGIN_CUSTOMER_ID_${tenantId}`] ?? process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    };
    return GoogleAdsAuthContextSchema.parse(auth);
  }
}

export interface OAuthTokenBundle {
  accessToken: string;
  expiresAtMs: number;
  refreshToken?: string;
}

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Refresh an OAuth access token against Google's token endpoint.
 * Refresh tokens live in Worker Secrets; this function signature keeps them
 * out of long-lived closures (caller passes the secret at call time).
 */
export async function refreshAccessToken(opts: {
  fetchFn: typeof fetch;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<OAuthTokenBundle> {
  const res = await opts.fetchFn(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      refresh_token: opts.refreshToken,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(`oauth_refresh_failed: ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!body.access_token) throw new Error("oauth_refresh_failed: no access_token in response");
  return {
    accessToken: body.access_token,
    expiresAtMs: Date.now() + (body.expires_in ?? 3600) * 1000,
    refreshToken: body.refresh_token,
  };
}
