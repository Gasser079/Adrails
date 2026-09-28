// @adrails/ads-client — F1: API Rate Shield & Auth Proxy for Google Ads REST v25.
export { EnvGoogleAdsCredentialProvider, refreshAccessToken } from "./auth.js";
export type { GoogleAdsCredentialProvider, GoogleAdsAuthContext, OAuthTokenBundle } from "./auth.js";
export { FileCredentialProvider } from "./file-credentials.js";
export type { FileCredentialOptions } from "./file-credentials.js";
export { buildAdsHeaders, assertCustomerId } from "./headers.js";
export { GoogleAdsErrorMapper, AdsApiError } from "./errors.js";
export type { ClassifiedAdsError } from "./errors.js";
export { ENDPOINTS, ADS_REST_BASE, ADS_API_VERSION, customersPath, customersActionPath } from "./endpoints.js";
export { retryWithBackoff, backoffMs, PerCustomerGate, KvResponseCache, DEFAULT_RETRY } from "./rate.js";
export type { RetryPolicy, KvLike } from "./rate.js";
export { GoogleAdsRestClient } from "./client.js";
export type { RestClientDeps, GaqlSearchInput } from "./client.js";
