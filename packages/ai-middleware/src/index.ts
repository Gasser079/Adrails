// @adrails/ai-middleware — F2: Schema-Enforced AI Middleware.
export { AiGatewayClient } from "./gateway.js";
export type { GatewayConfig, GatewayCall, GatewayMessage, GatewayResult } from "./gateway.js";
export { routeTask, modelFor, DEFAULT_TIER_MODELS } from "./tiers.js";
export type { ModelTier, AiTask, TierModels } from "./tiers.js";
export { guard, guardWithReprompt, SchemaGuardError } from "./schema-guard.js";
export type { GuardFailure } from "./schema-guard.js";
