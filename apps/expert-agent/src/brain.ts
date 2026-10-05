// @adrails/expert-agent/brain — fully self-hosted Workers AI chain with tool calling.
// primary gpt-oss-120b (OpenAI-compatible shape) -> fallback llama-3.3-70b (native shape).
// A 429/5xx/network failure advances the chain; anything else throws (fail-closed).
// No third-party keys: the only credential in play is the Worker's own AI binding.
import type { DiscoveryToolDef } from "./discovery-tools.generated.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface BrainResult {
  model: string;
  content: string;
  toolCalls: ToolCall[];
}

export interface BrainDeps {
  primaryModel: string;
  fallbackModel: string;
  ai: { run(model: string, input: unknown): Promise<unknown> };
}

export const DEFAULT_PRIMARY_MODEL = "@cf/openai/gpt-oss-120b";
export const DEFAULT_FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** gpt-oss via Workers AI answers in the OpenAI shape: choices[0].message.tool_calls[]. */
function normalizeOpenAiChoice(json: unknown, model: string): BrainResult | null {
  const msg = (json as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }> })?.choices?.[0]?.message;
  if (!msg) return null;
  const calls: ToolCall[] = (msg?.tool_calls ?? [])
    .filter((t) => t.function?.name)
    .map((t, i) => ({ id: t.id ?? `call-${i}`, name: t.function!.name!, arguments: parseArgs(t.function!.arguments) }));
  const content = typeof msg?.content === "string" ? msg.content : "";
  return { model, content, toolCalls: calls };
}

/** llama-style native shape: { response, tool_calls: [{ name, arguments }] }. */
function normalizeNative(out: unknown, model: string): BrainResult {
  const o = out as { response?: string; tool_calls?: Array<{ id?: string; name?: string; arguments?: unknown }> };
  if (typeof o?.response === "string" && !o.tool_calls) return { model, content: o.response, toolCalls: [] };
  const calls: ToolCall[] = (o?.tool_calls ?? [])
    .filter((t) => t.name)
    .map((t, i) => ({ id: t.id ?? `call-${i}`, name: t.name!, arguments: parseArgs(t.arguments) }));
  return { model, content: typeof o?.response === "string" ? o.response : "", toolCalls: calls };
}

const isTransient = (err: unknown): boolean => {
  const msg = String((err as Error)?.message ?? err ?? "");
  if (/\b429\b|rate.limit|too many requests/i.test(msg)) return true;
  if (/\b5\d\d\b|internal error|server error|overloaded|capacity|try again|temporar/i.test(msg)) return true;
  if (/timeout|timed out|network|fetch failed|cannot connect|connection|econn|enotfound|etimedout|socket/i.test(msg)) return true;
  return false;
};

async function modelComplete(deps: BrainDeps, model: string, messages: ChatMessage[], tools: ToolSchema[]): Promise<BrainResult> {
  const out = await deps.ai.run(model, {
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  });
  return normalizeOpenAiChoice(out, model) ?? normalizeNative(out, model);
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** One reasoning step with automatic fallback across the self-hosted chain. */
export async function think(deps: BrainDeps, messages: ChatMessage[], tools: ToolSchema[]): Promise<BrainResult> {
  const errors: string[] = [];
  for (const model of [deps.primaryModel, deps.fallbackModel]) {
    try {
      return await modelComplete(deps, model, messages, tools);
    } catch (err) {
      errors.push(`${model}: ${(err as Error)?.message ?? err}`);
      if (!isTransient(err)) throw err;
    }
  }
  throw new Error(`brain_chain_exhausted: ${errors.join(" | ").slice(0, 400)}`);
}
