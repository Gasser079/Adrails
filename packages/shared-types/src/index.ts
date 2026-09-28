// @adrails/shared-types — system contracts shared by every Adrails package.
// Dependency rule: core/domain/delivery may import here; this package imports nothing.
import { z } from "zod";

/** Canonical digit-only customer id (Google rejects dashes in headers). */
export const CustomerIdSchema = z.string().regex(/^[0-9]{1,10}$/, "customer id must be digits only (no dashes)");
export type CustomerId = z.infer<typeof CustomerIdSchema>;

/** Dual-ID scope for one API call: manager (auth context) + target client (path/body). */
export const TenantScopeSchema = z.object({
  tenantId: z.string().min(1),
  /** Agency manager (MCC) customer id — goes into the login-customer-id header. */
  loginCustomerId: CustomerIdSchema,
  /** Target advertiser account — goes into the {+customerId} path. */
  customerId: CustomerIdSchema,
  linkedCustomerId: CustomerIdSchema.optional(),
});
export type TenantScope = z.infer<typeof TenantScopeSchema>;

/** Action lifecycle — framework state machine (VALIDATED/INVALIDATED included). */
export const ActionStatusSchema = z.enum([
  "PROPOSED",
  "VALIDATED",
  "APPROVED",
  "DISPATCHED",
  "EXECUTED",
  "REJECTED",
  "INVALIDATED",
  "FAILED",
  "EXPIRED",
]);
export type ActionStatus = z.infer<typeof ActionStatusSchema>;

export const RiskTierSchema = z.enum(["low", "medium", "high"]);
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const RiskScoreSchema = z.number().min(0).max(1);

export const ActionProposalSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  customerId: CustomerIdSchema,
  entityType: z.string().min(1),
  actionType: z.string().min(1),
  payload: z.unknown(),
  riskScore: RiskScoreSchema,
  riskTier: RiskTierSchema,
  status: ActionStatusSchema,
  createdBy: z.enum(["SYSTEM_AI", "USER_EXPLICIT", "AUTOMATION"]),
  createdAt: z.string(),
});
export type ActionProposal = z.infer<typeof ActionProposalSchema>;

/** OAuth context for one tenant (developer token deliberately absent — sunset). */
export const GoogleAdsAuthContextSchema = z.object({
  clientId: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  accessToken: z.string().min(1).optional(),
  customerId: CustomerIdSchema,
  loginCustomerId: CustomerIdSchema.optional(),
});
export type GoogleAdsAuthContext = z.infer<typeof GoogleAdsAuthContextSchema>;

/** Normalized provider error: deterministic classification for the shield. */
export const ProviderErrorCategorySchema = z.enum([
  "AUTHENTICATION",
  "AUTHORIZATION",
  "ACCESS_NOT_APPROVED",
  "VALIDATION",
  "NOT_FOUND",
  "RATE_LIMIT",
  "TRANSIENT",
  "TIMEOUT",
  "INTERNAL",
  "UNKNOWN",
]);
export type ProviderErrorCategory = z.infer<typeof ProviderErrorCategorySchema>;
