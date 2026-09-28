// @adrails/ads-client/headers — the MCC dual-ID header contract.
// Every v1 call carries login-customer-id (manager MCC) + {+customerId} (target).
// EXCEPTION: ListAccessibleCustomers uses raw OAuth only (no login-customer-id).
import { CustomerIdSchema } from "@adrails/shared-types";

export interface DualId {
  /** Manager (MCC) customer id for the login-customer-id header. */
  loginCustomerId?: string;
  /** Target client customer id — also embedded in REST paths. */
  customerId: string;
  linkedCustomerId?: string;
  accessToken: string;
}

const assertId = (value: string): string => CustomerIdSchema.parse(value);

export function buildAdsHeaders(ids: DualId): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ids.accessToken}`,
    "Content-Type": "application/json",
  };
  if (ids.loginCustomerId !== undefined) headers["login-customer-id"] = assertId(ids.loginCustomerId);
  // customerId is validated wherever a path is built; validate here too for safety.
  assertId(ids.customerId);
  if (ids.linkedCustomerId !== undefined) headers["linked-customer-id"] = assertId(ids.linkedCustomerId);
  return headers;
}

/** Assert a customer-id-like value is digits-only (dashes rejected by Google). */
export function assertCustomerId(value: string): string {
  return CustomerIdSchema.parse(value);
}
