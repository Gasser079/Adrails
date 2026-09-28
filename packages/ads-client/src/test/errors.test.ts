import test from "node:test";
import assert from "node:assert";
import { GoogleAdsErrorMapper } from "../errors.js";

test("post-sunset guidance: CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION maps to guidance", () => {
  const m = GoogleAdsErrorMapper.mapError({
    message: "denied",
    errors: [{ message: "denied", errorCode: { authorizationError: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION" } }],
  });
  assert.strictEqual(m.category, "ACCESS_NOT_APPROVED");
  assert.strictEqual(m.retryable, false);
  assert.ok(m.guidance?.includes("console.cloud.google.com/google/ads-apis/overview"), "must point at the GCP console");
});

test("quota: RESOURCE_EXHAUSTED is retryable only under keyword-planning capability context", () => {
  const kp = GoogleAdsErrorMapper.mapError(
    { errors: [{ message: "x", errorCode: { quotaError: "RESOURCE_EXHAUSTED" } }] },
    { capabilityId: "search_volume_discovery" },
  );
  assert.strictEqual(kp.category, "RATE_LIMIT");
  assert.strictEqual(kp.retryable, true);
  assert.strictEqual(kp.countsTowardBreaker, false);
  const other = GoogleAdsErrorMapper.mapError(
    { errors: [{ message: "x", errorCode: { quotaError: "RESOURCE_EXHAUSTED" } }] },
    { capabilityId: "google_ads_mutate" },
  );
  assert.strictEqual(other.retryable, false);
  assert.strictEqual(other.countsTowardBreaker, true);
});

test("validation enums are fail-closed, never retryable", () => {
  for (const t of ["requestError", "fieldError", "mutateError", "queryError"]) {
    const m = GoogleAdsErrorMapper.mapError({ errors: [{ message: "x", errorCode: { [t]: "SOMETHING" } }] });
    assert.strictEqual(m.category, "VALIDATION");
    assert.strictEqual(m.retryable, false);
  }
});

test("REST fallback: 429 retryable, 401/403 fail-closed, 503 transient", () => {
  assert.strictEqual(GoogleAdsErrorMapper.mapError({ code: 401 }).category, "AUTHENTICATION");
  assert.strictEqual(GoogleAdsErrorMapper.mapError({ code: 403 }).category, "AUTHORIZATION");
  assert.strictEqual(GoogleAdsErrorMapper.mapError({ code: 401 }).retryable, false);
  assert.strictEqual(GoogleAdsErrorMapper.mapError({ code: 429 }).category, "RATE_LIMIT");
  assert.strictEqual(GoogleAdsErrorMapper.mapError({ code: 503 }).retryable, true);
});
