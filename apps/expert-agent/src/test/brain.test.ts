import test from "node:test";
import assert from "node:assert";
import { think, DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL, type BrainDeps } from "../brain.js";
import type { DiscoveryToolDef } from "../discovery-tools.generated.js";

const TOOLS: DiscoveryToolDef[] = [
  { name: "ping", description: "ping", parameters: { type: "object", properties: {}, required: [] }, httpMethod: "GET", path: "ping", scopes: [] },
];

function depsWith(aiRun: (model: string) => Promise<unknown>): BrainDeps {
  return { primaryModel: DEFAULT_PRIMARY_MODEL, fallbackModel: DEFAULT_FALLBACK_MODEL, ai: { run: aiRun } };
}

test("brain: transient 429 on primary falls to llama, then answers (native shape)", async () => {
  const seen: string[] = [];
  const r = await think(depsWith(async (model: string) => {
    seen.push(model);
    if (model === DEFAULT_PRIMARY_MODEL) throw new Error("AI error 429 rate limited");
    return { response: "hello from llama", tool_calls: [] };
  }), [{ role: "user", content: "hi" }], TOOLS);
  assert.strictEqual(r.model, DEFAULT_FALLBACK_MODEL);
  assert.strictEqual(r.content, "hello from llama");
  assert.deepStrictEqual(seen, [DEFAULT_PRIMARY_MODEL, DEFAULT_FALLBACK_MODEL]);
});

test("brain: OpenAI-shape tool calls (gpt-oss) normalize to {id,name,arguments}", async () => {
  const r = await think(depsWith(async () => ({
    choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "ping", arguments: "{\"a\":1}" } }] } }],
  })), [{ role: "user", content: "hi" }], TOOLS);
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].name, "ping");
  assert.deepStrictEqual(r.toolCalls[0].arguments, { a: 1 });
});

test("brain: native-shape tool calls (llama) normalize to {id,name,arguments}", async () => {
  const r = await think(depsWith(async () => ({
    response: "", tool_calls: [{ name: "ping", arguments: { a: 2 } }],
  })), [{ role: "user", content: "hi" }], TOOLS);
  assert.strictEqual(r.toolCalls.length, 1);
  assert.strictEqual(r.toolCalls[0].name, "ping");
  assert.deepStrictEqual(r.toolCalls[0].arguments, { a: 2 });
});

test("brain: non-transient (model unavailable) throws immediately, fallback untouched", async () => {
  const seen: string[] = [];
  await assert.rejects(think(depsWith(async (model: string) => {
    seen.push(model);
    throw new Error("Model not available on this plan");
  }), [{ role: "user", content: "hi" }], TOOLS), /not available/);
  assert.deepStrictEqual(seen, [DEFAULT_PRIMARY_MODEL]);
});

test("brain: chain exhaustion throws when both models transient-fail", async () => {
  await assert.rejects(think(depsWith(async () => {
    throw new Error("AI error 503 overloaded, try again");
  }), [{ role: "user", content: "hi" }], TOOLS), /brain_chain_exhausted/);
});
