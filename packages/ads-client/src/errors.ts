// @adrails/ads-client/errors — ported compass: Google Ads failure enum ->
// deterministic (category, retryable, breaker) triple. Extended with the
// post-sunset access guidance codes.
import type { ProviderErrorCategory } from "@adrails/shared-types";

export interface ClassifiedAdsError {
  message: string;
  category: ProviderErrorCategory;
  providerCode: string;
  retryable: boolean;
  countsTowardBreaker: boolean;
  /** Human/tenant guidance when the failure needs console action (never silent). */
  guidance?: string;
}

const ACCESS_GUIDANCE =
  "This Google Cloud project's Ads API access is not approved for production. Apply at console.cloud.google.com/google/ads-apis/overview (Explorer/Basic/Standard).";

export class AdsApiError extends Error {
  readonly category: ProviderErrorCategory;
  readonly providerCode: string;
  readonly retryable: boolean;
  readonly countsTowardBreaker: boolean;
  readonly guidance?: string;
  constructor(mapped: ClassifiedAdsError) {
    super(`[${mapped.category}] ${mapped.message}`);
    this.name = "AdsApiError";
    this.category = mapped.category;
    this.providerCode = mapped.providerCode;
    this.retryable = mapped.retryable;
    this.countsTowardBreaker = mapped.countsTowardBreaker;
    this.guidance = mapped.guidance;
  }
}
export class GoogleAdsErrorMapper {
  public static mapError(err: unknown, context?: { capabilityId?: string }): ClassifiedAdsError {
    const e = err as { name?: string; message?: string; code?: unknown; errors?: Array<{ message?: string; errorCode?: Record<string, string> }>; requestId?: string };
    if (e?.name === "AbortError") {
      return { message: "Execution aborted", category: "UNKNOWN", providerCode: "ABORT", retryable: false, countsTowardBreaker: false };
    }
    let category: ProviderErrorCategory = "INTERNAL";
    let retryable = false;
    let breaker = true;
    let providerCode = String(e?.code ?? "UNKNOWN");
    let guidance: string | undefined;
    let message = e?.message ?? "Unknown Google Ads API error";

    const details = e?.errors;
    if (details && Array.isArray(details) && details.length > 0) {
      const first = details[0] as { message?: string; errorCode?: Record<string, string> };
      const errorCodeObj = first.errorCode ?? {};
      const keys = Object.keys(errorCodeObj);
      const type = keys.length > 0 ? keys[0] : null;
      const code = type ? errorCodeObj[type] : null;
      if (type && code) providerCode = `${type}.${code}`;
      message = first.message ?? message;

      // Post-sunset access guidance (v25 CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION / legacy ACTION_NOT_PERMITTED).
      if (code === "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" || (type === "authorizationError" && code === "ACTION_NOT_PERMITTED" && (context?.capabilityId ?? "").length === 0)) {
        return { message, category: "ACCESS_NOT_APPROVED", providerCode, retryable: false, countsTowardBreaker: false, guidance: ACCESS_GUIDANCE };
      }

      switch (type) {
        case "authenticationError": category = "AUTHENTICATION"; retryable = false; breaker = false; break;
        case "authorizationError": category = "AUTHORIZATION"; retryable = false; breaker = false; break;
        case "quotaError":
          category = "RATE_LIMIT";
          if (code === "RESOURCE_TEMPORARILY_EXHAUSTED") { retryable = true; breaker = false; }
          else if (code === "RESOURCE_EXHAUSTED") {
            const kp = context?.capabilityId === "search_volume_discovery" || context?.capabilityId === "cpc_forecasting";
            if (kp) { retryable = true; breaker = false; } else { retryable = false; breaker = true; }
          } else { retryable = false; breaker = true; }
          break;
        case "resourceCountLimitExceededError": category = "RATE_LIMIT"; retryable = false; breaker = false; break;
        case "requestError":
        case "fieldError":
        case "mutateError":
        case "queryError": category = "VALIDATION"; retryable = false; breaker = false; break;
        case "internalError": category = "INTERNAL"; retryable = true; breaker = true; break;
      }
    } else {
      // REST HTTP fallback (Workers transports don't see gRPC enums here — except when parsed from error bodies).
      switch (e?.code) {
        case 401: case "UNAUTHENTICATED": category = "AUTHENTICATION"; retryable = false; breaker = false; break;
        case 403: case "PERMISSION_DENIED": category = "AUTHORIZATION"; retryable = false; breaker = false; break;
        case 400: case "INVALID_ARGUMENT": category = "VALIDATION"; retryable = false; breaker = false; break;
        case 404: case "NOT_FOUND": category = "NOT_FOUND"; retryable = false; breaker = false; break;
        case 429: case "RESOURCE_EXHAUSTED":
          category = "RATE_LIMIT";
          retryable = context?.capabilityId === "search_volume_discovery" || context?.capabilityId === "cpc_forecasting";
          breaker = !retryable;
          break;
        case 408: case "DEADLINE_EXCEEDED": category = "TIMEOUT"; retryable = true; breaker = true; break;
        case 503: case "UNAVAILABLE":
        case 500: case "INTERNAL": category = "TRANSIENT"; retryable = true; breaker = true; break;
      }
    }
    return { message, category, providerCode, retryable, countsTowardBreaker: breaker, guidance };
  }
}
