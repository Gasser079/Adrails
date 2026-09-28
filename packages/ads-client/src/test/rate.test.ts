import test from "node:test";
import assert from "node:assert";
import { retryWithBackoff, backoffMs, PerCustomerGate, KvResponseCache } from "../rate.js";

test("backoff: exponential with bounds, deterministic with injected rand", () => {
  const p = { maxAttempts: 4, baseMs: 250, maxMs: 8000, jitterRatio: 0.25 };
  assert.strictEqual(backoffMs(0, p, () => 0.5), 250);
  assert.strictEqual(backoffMs(1, p, () => 0.5), 500);
  assert.strictEqual(backoffMs(10, p, () => 0.5), 8000);
  const jittered = backoffMs(1, p, () => 0);
  assert.ok(jittered < 500 && jittered >= 375, `jitter clamps inside band (got ${jittered})`);
});

test("retryWithBackoff: succeeds after transient failures, then stops retrying", async () => {
  let calls = 0;
  const out = await retryWithBackoff(async () => {
    calls++;
    if (calls < 3) throw new Error("flaky");
    return "ok";
  }, { policy: { maxAttempts: 4, baseMs: 1, maxMs: 2, jitterRatio: 0 }, sleep: async () => {} });
  assert.strictEqual(out, "ok");
  assert.strictEqual(calls, 3);
});

test("retryWithBackoff: non-retryable fails fast on first attempt", async () => {
  let calls = 0;
  await assert.rejects(
    retryWithBackoff(async () => { calls++; throw new Error("fatal"); }, { sleep: async () => {}, shouldRetry: () => false }),
    /fatal/,
  );
  assert.strictEqual(calls, 1);
});

test("PerCustomerGate: same customer serializes, different customers run parallel", async () => {
  const gate = new PerCustomerGate();
  const order: string[] = [];
  const slow = (id: string, ms: number) => gate.run("same", async () => {
    order.push(`${id}:start`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`${id}:end`);
  });
  await Promise.all([slow("a", 30), slow("b", 1)]);
  assert.deepStrictEqual(order, ["a:start", "a:end", "b:start", "b:end"], "same-customer calls must serialize");
  // different customers must not block each other
  const t0 = Date.now();
  await Promise.all([
    gate.run("c1", async () => new Promise((r) => setTimeout(r, 40))),
    gate.run("c2", async () => new Promise((r) => setTimeout(r, 40))),
  ]);
  assert.ok(Date.now() - t0 < 80, "independent customers run concurrently");
});

test("KvResponseCache: null backend is a safe pass-through", async () => {
  const c = new KvResponseCache(null);
  assert.strictEqual(await c.get("k"), null);
  await c.put("k", { a: 1 }, 60);
  assert.strictEqual(await c.get("k"), null);
});
