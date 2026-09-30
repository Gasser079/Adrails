import test from "node:test";
import assert from "node:assert";
import { think, type BrainDeps } from "../brain.js";
import type { DiscoveryToolDef } from "../discovery-tools.generated.js";

const TOOLS: DiscoveryToolDef[] = [
  { name: "ping", description: "ping", parameters: { type: "object", properties: {}, required: [] }, httpMethod: "GET", path: "ping", scopes: [] },
];

function depsWith(fetchFn: typeof fetch, extra: Partial<BrainDeps> = {}): BrainDeps {
  return {
    groqApiKey: "k",
    groqApiBase: "https://api.groq.com/openai/v1",
    primaryModel: "openai/gpt-oss-120b",
    fallbackModel: "qwen/qwen3.8-27b",
    workersAiModel: "@hf/nousresearch/hermes-2-pro-mistral-7b",
    fetchFn,
    ...extra,
  };
}

test("brain: 429 on primary falls to qwen, then answers", async () => {
  const seen: string[] = [];
  const fetchFn = (async (url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    seen.push(body.model ?? "?");
    if (body.model === "openai/gpt-oss-120b") {
      return { ok: false, status: 429, text: async () => "rate limited" };
    }
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: "hello from qwen", tool_calls: [] } }] }),
    };
  }) as unknown as typeof fetch;
  const r = await think(depsWith(fetchFn), [{ role: "user", content: "hi" }], TOOLS);
  assert.strictEqual(r.model, "qwen/qwen3.8-27b");
  assert.strictEqual(r.content, "hello from qwen");
  assert.deepStrictEqual(seen, ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
});

test("brain: tool calls normalize to {id,name,arguments}", async () => {
  const fetchFn = (async () => ({
    ok: true, status: 200,
    json: async () => ({
      choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name: "ping", arguments: "{\"a\":1}" } }] } }],
    }),
  })) as unknown as typeof fetch;
  const r = await think(depsWith(fetchFn), [{ role: "user", content: "hi" }], TOOLS);
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].name, "ping");
  assert.deepStrictEqual(r.toolCalls[0].arguments, { a: 1 });
});

test("brain: chain exhaustion throws (both groq models down, no workers AI)", async () => {
  const fetchFn = (async () => ({ ok: false, status: 500, text: async () => "down" })) as unknown as typeof fetch;
  await assert.rejects(think(depsWith(fetchFn), [{ role: "user", content: "hi" }], TOOLS), /brain_chain_exhausted/);
});
