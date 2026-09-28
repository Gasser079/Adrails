import test from "node:test";
import assert from "node:assert";
import { routeTask, modelFor } from "../tiers.js";
import { AiGatewayClient } from "../gateway.js";

test("tier router: cheap tasks tier1, strategy tasks tier2, embeddings tier3", () => {
  assert.strictEqual(routeTask("intent_tag"), "tier1");
  assert.strictEqual(routeTask("char_validate"), "tier1");
  assert.strictEqual(routeTask("parse_json"), "tier1");
  assert.strictEqual(routeTask("strategize"), "tier2");
  assert.strictEqual(routeTask("copywrite"), "tier2");
  assert.strictEqual(routeTask("diagnose"), "tier2");
  assert.strictEqual(routeTask("embed"), "tier3");
  assert.strictEqual(modelFor("strategize"), "claude-3-5-sonnet");
});

test("gateway: hits the Cloudflare AI Gateway endpoint with provider auth + schema", async () => {
  const log: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const gw = new AiGatewayClient({
    accountId: "acct",
    gatewayId: "gw",
    provider: "openai",
    providerApiKey: "k",
    fetchFn: (async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      log.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ?? "" });
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"a":1}' } }], model: "gpt-4o", usage: { prompt_tokens: 5, completion_tokens: 2 } }) } as unknown as Response;
    }) as typeof fetch,
  });
  const res = await gw.complete({ model: "gpt-4o", messages: [{ role: "user", content: "hi" }], jsonSchema: { type: "object" } });
  assert.ok(log[0].url.startsWith("https://gateway.ai.cloudflare.com/v1/acct/gw/openai"));
  assert.strictEqual(log[0].headers["Authorization"], "Bearer k");
  assert.ok(log[0].body.includes("json_schema"));
  assert.strictEqual(res.text, '{"a":1}');
  assert.strictEqual(res.usage?.promptTokens, 5);
});
