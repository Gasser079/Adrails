// @adrails/expert-agent — the cloud Ads expert (Agents SDK, per-tenant DO).
// Discovery-grounded reads + ledger-gated writes. No knowledge bases.
import { Agent, callable } from "agents";
import type {} from "@cloudflare/workers-types";
import { EXPERT_SYSTEM_PROMPT } from "./manual.js";
import { think, type BrainDeps, type ChatMessage } from "./brain.js";
import {
  trimTools, LEDGER_TOOL_DEFS, executeToolCall,
  type ToolRuntime, type ExecutedTool,
} from "./tools.js";
import { DISCOVERY_TOOLS } from "./discovery-tools.generated.js";
import { ActionLedgerRepository, TenantRepository, type D1Like } from "@adrails/action-ledger";
import type { KvLike } from "@adrails/ads-client";

export interface ExpertEnv extends Cloudflare.Env {
  LEDGER_DB: unknown;
  CACHE: unknown;
  AI: { run(model: string, input: unknown): Promise<unknown> };
  GROQ_API_KEY?: string;
  GROQ_API_BASE?: string;
  GROQ_PRIMARY_MODEL?: string;
  GROQ_FALLBACK_MODEL?: string;
  WORKERS_AI_FALLBACK_MODEL?: string;
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

const MAX_TURNS = 6;

export class ExpertAgent extends Agent<ExpertEnv, ExpertState> {
  @callable()
  async ask(input: { tenantId: string; question: string }): Promise<AskResult> {
    const requestId = `exp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const db = this.env.LEDGER_DB as unknown as D1Like;
    const tenantRepo = new TenantRepository(db);
    const tenant = await tenantRepo.getTenant(input.tenantId);
    if (!tenant) {
      return this.escalate(requestId, input.tenantId, "unknown tenant: onboard it via account-discovery first");
    }
    const clients = await tenantRepo.listClients(input.tenantId);
    const kv = this.env.CACHE as unknown as KvLike | null;
    const rt: ToolRuntime = {
      tenantId: input.tenantId,
      loginCustomerId: tenant.loginCustomerId,
      managedCustomerIds: clients.map((c) => c.customerId),
      googleOAuth: {
        clientId: this.env.GOOGLE_ADS_CLIENT_ID ?? "",
        clientSecret: this.env.GOOGLE_ADS_CLIENT_SECRET ?? "",
        refreshToken: this.env.GOOGLE_ADS_REFRESH_TOKEN ?? "",
      },
      kv,
      ledger: new ActionLedgerRepository(db),
    };
    if (!rt.googleOAuth.clientId || !rt.googleOAuth.refreshToken) {
      return this.escalate(requestId, input.tenantId, "Google OAuth not configured on this worker (Worker Secrets missing)");
    }

    const trimmed = trimTools(input.question, 12);
    const defs = new Map(trimmed.map((d) => [d.name, d]));
    const brainDeps: BrainDeps = {
      groqApiKey: this.env.GROQ_API_KEY,
      groqApiBase: this.env.GROQ_API_BASE ?? "https://api.groq.com/openai/v1",
      primaryModel: this.env.GROQ_PRIMARY_MODEL ?? "openai/gpt-oss-120b",
      fallbackModel: this.env.GROQ_FALLBACK_MODEL ?? "qwen/qwen3.8-27b",
      workersAiModel: this.env.WORKERS_AI_FALLBACK_MODEL ?? "@hf/nousresearch/hermes-2-pro-mistral-7b",
      ai: this.env.AI,
    };
    const toolSchemas = [...trimmed, ...LEDGER_TOOL_DEFS];
    const messages: ChatMessage[] = [
      { role: "system", content: EXPERT_SYSTEM_PROMPT },
      { role: "user", content: input.question },
    ];
    const citations: AskResult["chase"]["citations"] = [];
    for (let i = 0; i < MAX_TURNS; i++) {
      let step;
      try {
        step = await think(brainDeps, messages, toolSchemas);
      } catch (err) {
        return this.escalate(requestId, input.tenantId, `brain unavailable: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }
      if (!step.toolCalls.length) {
        const text = step.content.trim() || "I could not ground an answer from the available tools, so I am not answering.";
        await this.bumpTurns(input.tenantId, tenant.loginCustomerId);
        return {
          reply_text: text,
          chase: { request_id: requestId, status: citations.length ? "success" : "escalated", confidence: citations.length ? 0.65 : 0.0, citations, tenant_id: input.tenantId },
        };
      }
      messages.push({ role: "assistant", content: step.content, tool_calls: step.toolCalls });
      for (const call of step.toolCalls) {
        const done = await executeToolCall(rt, call, defs);
        if (done.citation) citations.push(done.citation);
        messages.push({ role: "tool", content: done.text, tool_call_id: call.id, name: call.name });
      }
    }
    return this.escalate(requestId, input.tenantId, "reasoning budget exhausted without a grounded answer");
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
