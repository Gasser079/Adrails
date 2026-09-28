// @adrails/ai-middleware/tiers — 3-tier model router (cost/latency/context).
// Never use a frontier tier for a task a cheap tier solves.
export const ModelTierSchema = ["tier1", "tier2", "tier3"] as const;
export type ModelTier = (typeof ModelTierSchema)[number];

export type AiTask =
  | "intent_tag"
  | "char_validate"
  | "parse_json"
  | "entity_extract"
  | "strategize"
  | "copywrite"
  | "diagnose"
  | "embed";

/** Provider-agnostic model handles — resolved to concrete model ids at deploy. */
export interface TierModels {
  tier1: string;
  tier2: string;
  tier3: string;
}

export const DEFAULT_TIER_MODELS: TierModels = {
  tier1: "llama-3.1-8b-instruct",
  tier2: "claude-3-5-sonnet",
  tier3: "bge-small-en-v1.5",
};

const ROUTES: Record<AiTask, ModelTier> = {
  intent_tag: "tier1",
  char_validate: "tier1",
  parse_json: "tier1",
  entity_extract: "tier1",
  strategize: "tier2",
  copywrite: "tier2",
  diagnose: "tier2",
  embed: "tier3",
};

export function routeTask(task: AiTask): ModelTier {
  return ROUTES[task];
}

export function modelFor(task: AiTask, models: TierModels = DEFAULT_TIER_MODELS): string {
  return models[routeTask(task)];
}
