// @adrails/expert-agent/brain — model chain with tool calling.
// Primary + fallback: Groq OpenAI-compatible (gpt-oss-120b -> qwen3.8-27b).
// Final fallback: Workers AI hermes (no key, neuron pool).
// A 429/5xx/network failure advances the chain; anything else throws.
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
  groqApiKey?: string;
  groqApiBase: string;
  primaryModel: string;
  fallbackModel: string;
  workersAiModel: string;
  ai?: { run(model: string, input: unknown): Promise<unknown> };
  fetchFn?: typeof fetch;
}

const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw ?? "{}")) as Record<string, unknown>;
  } catch {
    return {};
  }
};

function normalizeGroqChoice(json: unknown, model: string): BrainResult {
  const msg = (json as { choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }> })?.choices?.[0]?.message;
  const calls: ToolCall[] = (msg?.tool_calls ?? [])
    .filter((t) => t.function?.name)
    .map((t, i) => ({ id: t.id ?? `call-${i}`, name: t.function!.name!, arguments: parseArgs(t.function!.arguments) }));
  const content = typeof msg?.content === "string" ? msg.content : "";
  return { model, content, toolCalls: calls };
}

function normalizeWorkersAi(out: unknown, model: string): BrainResult {
  const o = out as { response?: string; tool_calls?: Array<{ id?: string; name?: string; arguments?: unknown }> };
  if (typeof o?.response === "string" && !o.tool_calls) return { model, content: o.response, toolCalls: [] };
  const calls: ToolCall[] = (o?.tool_calls ?? [])
    .filter((t) => t.name)
    .map((t, i) => ({ id: t.id ?? `call-${i}`, name: t.name!, arguments: parseArgs(t.arguments) }));
  return { model, content: typeof o?.response === "string" ? o.response : "", toolCalls: calls };
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

async function groqComplete(deps: BrainDeps, model: string, messages: ChatMessage[], tools: ToolSchema[]): Promise<BrainResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const res = await fetchFn(`${deps.groqApiBase}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.groqApiKey}` },
    body: JSON.stringify({
      model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.tool_calls?.length
          ? { tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } })) }
          : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id, name: m.name } : {}),
      })),
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      tool_choice: "auto",
    }),
  });
  if (res.status === 429 || res.status >= 500) {
    throw Object.assign(new Error(`groq_transient_${res.status}`), { transient: true });
  }
  if (!res.ok) throw new Error(`groq_failed_${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return normalizeGroqChoice(await res.json(), model);
}

async function workersAiComplete(deps: BrainDeps, messages: ChatMessage[], tools: ToolSchema[]): Promise<BrainResult> {
  if (!deps.ai) throw new Error("workers_ai_unavailable");
  const out = await deps.ai.run(deps.workersAiModel, {
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
  });
  return normalizeWorkersAi(out, deps.workersAiModel);
}

/** One reasoning step with automatic fallback across the chain. */
export async function think(deps: BrainDeps, messages: ChatMessage[], tools: ToolSchema[]): Promise<BrainResult> {
  const errors: string[] = [];
  if (deps.groqApiKey) {
    for (const model of [deps.primaryModel, deps.fallbackModel]) {
      try {
        return await groqComplete(deps, model, messages, tools);
      } catch (err) {
        errors.push(`${model}: ${(err as Error)?.message ?? err}`);
        if (!(err as { transient?: boolean })?.transient) throw err;
      }
    }
  }
  try {
    return await workersAiComplete(deps, messages, tools);
  } catch (err) {
    errors.push(`workers-ai: ${(err as Error)?.message ?? err}`);
    throw new Error(`brain_chain_exhausted: ${errors.join(" | ").slice(0, 400)}`);
  }
}
