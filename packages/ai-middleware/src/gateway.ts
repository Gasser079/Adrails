// @adrails/ai-middleware/gateway — Cloudflare AI Gateway client (Tier routing).
// Every model call goes through the gateway: caching, failover, cost tracking.
export interface GatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface GatewayCall {
  model: string;
  messages: GatewayMessage[];
  /** Optional JSON-schema constraint (providers that support response_format). */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  temperature?: number;
}

export interface GatewayResult {
  text: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface GatewayConfig {
  accountId: string;
  gatewayId: string;
  providerApiKey: string;
  /** e.g. "openai" | "anthropic" | "workers-ai" */
  provider: string;
  fetchFn?: typeof fetch;
}

export class AiGatewayClient {
  private readonly fetchFn: typeof fetch;
  constructor(private readonly cfg: GatewayConfig) {
    this.fetchFn = cfg.fetchFn ?? fetch;
  }

  public endpoint(): string {
    return `https://gateway.ai.cloudflare.com/v1/${this.cfg.accountId}/${this.cfg.gatewayId}/${this.cfg.provider}`;
  }

  public async complete(call: GatewayCall, signal?: AbortSignal): Promise<GatewayResult> {
    const body: Record<string, unknown> = {
      model: call.model,
      messages: call.messages,
    };
    if (call.maxTokens !== undefined) body.max_tokens = call.maxTokens;
    if (call.temperature !== undefined) body.temperature = call.temperature;
    if (call.jsonSchema !== undefined) body.response_format = { type: "json_schema", json_schema: { name: "adrails_output", schema: call.jsonSchema } };

    const res = await this.fetchFn(this.endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.providerApiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`ai_gateway_${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? "";
    const text = typeof content === "string" ? content : content.map((p) => p.text ?? "").join("");
    return {
      text,
      model: json.model ?? call.model,
      usage: json.usage ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens } : undefined,
    };
  }
}
