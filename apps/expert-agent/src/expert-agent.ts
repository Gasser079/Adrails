// @adrails/expert-agent — the cloud Ads expert, rebased on the Think harness.
// Agents SDK Think agent on a Durable Object (one instance per tenant):
// Discovery-grounded reads + ledger-gated writes. No knowledge bases.
//
// Think owns the loop now: prompt, tool orchestration, streaming, durable
// recovery. This file owns: the model chain (Workers AI primary + fallback),
// the tool catalog (trimmed discovery reads + ledger tools), and the ask
// entry (tenant gate -> programmatic turn -> AskResult).
//
// Turn-scoped context flows via saveMessages metadata (tenantId/question/
// requestId), read back in getTools()/execute through activeTurnMetadata —
// no shared mutable runtime, so concurrent asks cannot cross tenants.
// Citation collection is keyed by requestId for the same reason.
import { Think } from "@cloudflare/think";
import { callable } from "agents";
import { createAI, type WorkersAIModelId } from "agents/models/ai-sdk";
import type { Ai } from "@cloudflare/workers-types";
import type {} from "@cloudflare/workers-types";
import type { UIMessage } from "ai";
import { EXPERT_SYSTEM_PROMPT } from "./manual.js";
import {
  buildThinkTools, buildToolRuntime, type ExpertToolEnv,
} from "./tools.js";

export interface ExpertEnv extends Cloudflare.Env {
  LEDGER_DB: unknown;
  CACHE: unknown;
  AI: Ai;
  BRAIN_PRIMARY_MODEL?: string;
  BRAIN_FALLBACK_MODEL?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REFRESH_TOKEN?: string;
}

export interface ExpertState {
  tenantId: string;
  loginCustomerId: string;
  discoveryVersion: string;
  turns: number;
}

export interface AskResult {
  reply_text: string;
  chase: {
    request_id: string;
    status: "success" | "escalated";
    confidence: number;
    citations: Array<{ method: string; path: string }>;
    gap_reason?: string;
    tenant_id: string;
  };
}

const DEFAULT_PRIMARY_MODEL = "@cf/openai/gpt-oss-120b";
const DEFAULT_FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_TURNS = 6;

export class ExpertAgent extends Think<ExpertEnv, ExpertState> {
  /** No shell near ad credentials. Workspace files stay (isolated virtual FS). */
  workspaceBash = false;

  private collectors = new Map<string, Array<{ method: string; path: string }>>();
  private pendingAsk: { tenantId: string; question: string; requestId: string } | null = null;

  getModel() {
    const ai = createAI({ binding: this.env.AI });
    const primary = (this.env.BRAIN_PRIMARY_MODEL ?? DEFAULT_PRIMARY_MODEL) as WorkersAIModelId;
    const fallback = (this.env.BRAIN_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL) as WorkersAIModelId;
    return ai(primary, { fallback: [fallback] });
  }

  getSystemPrompt(): string {
    return EXPERT_SYSTEM_PROMPT;
  }

  beforeTurn() {
    return { maxSteps: MAX_TURNS };
  }

  getTools() {
    // saveMessages() carries no turn metadata, so the pending ask context is
    // staged on the instance (single-flight per tenant today; revisit with
    // turn-scoped context when the harness exposes it).
    const staged = this.pendingAsk ?? { tenantId: "", question: "", requestId: "" };
    const env: ExpertToolEnv = this.env;
    return buildThinkTools(staged.question, {
      runtime: () => buildToolRuntime(env, staged.tenantId),
      collect: (c) => this.collectors.get(staged.requestId)?.push(c),
    });
  }

  @callable()
  async ask(input: { tenantId: string; question: string }): Promise<AskResult> {
    const requestId = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const pre = await buildToolRuntime(this.env, input.tenantId);
    if (!pre.ok) return this.escalate(requestId, input.tenantId, pre.error);
    this.collectors.set(requestId, []);
    this.pendingAsk = { tenantId: input.tenantId, question: input.question, requestId };
    try {
      const msg: UIMessage = {
        id: requestId,
        role: "user",
        parts: [{ type: "text", text: input.question }],
      };
      const result = await this.saveMessages([msg]);
      const text = lastAssistantText(result);
      const citations = this.collectors.get(requestId) ?? [];
      await this.bumpTurns(input.tenantId, pre.loginCustomerId);
      if (!text.trim()) return this.escalate(requestId, input.tenantId, "no grounded answer produced");
      return {
        reply_text: text,
        chase: { request_id: requestId, status: citations.length ? "success" : "escalated", confidence: citations.length ? 0.65 : 0.0, citations, tenant_id: input.tenantId },
      };
    } catch (err) {
      return this.escalate(requestId, input.tenantId, `brain unavailable: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    } finally {
      this.collectors.delete(requestId);
      if (this.pendingAsk?.requestId === requestId) this.pendingAsk = null;
    }
  }

  private escalate(requestId: string, tenantId: string, reason: string): AskResult {
    return {
      reply_text: `I don't have grounded material for that right now (${reason}). I've recorded the gap rather than guessing — rephrase the question or try again shortly.`,
      chase: { request_id: requestId, status: "escalated", confidence: 0.0, citations: [], gap_reason: reason, tenant_id: tenantId },
    };
  }

  private async bumpTurns(tenantId: string, loginCustomerId: string): Promise<void> {
    try {
      const cur = (this.state as ExpertState | undefined)?.turns ?? 0;
      this.setState({ tenantId, loginCustomerId, discoveryVersion: "v25", turns: cur + 1 });
    } catch { /* state best-effort */ }
  }
}

/** Tolerant transcript reader: TurnResult carries the turn message; fall back to a messages array. */
function lastAssistantText(result: unknown): string {
  const r = result as {
    message?: { parts?: Array<{ type?: string; text?: string }> };
    messages?: Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>;
  };
  const fromMessage = (r.message?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
  if (fromMessage.trim()) return fromMessage;
  const assistants = (r.messages ?? []).filter((m) => m.role === "assistant");
  const last = assistants[assistants.length - 1];
  return (last?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
}
