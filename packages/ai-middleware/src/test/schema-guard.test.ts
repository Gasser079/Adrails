import test from "node:test";
import assert from "node:assert";
import { z } from "zod";
import { guard, guardWithReprompt, SchemaGuardError } from "../schema-guard.js";

const Ad = z.object({ headline: z.string().max(30), desc: z.string().max(90) });

test("guard: valid JSON passes, returns typed data", async () => {
  const r = await guard(Ad, '{"headline":"Buy shoes","desc":"Great shoes"}');
  assert.ok(r.ok && r.ok === true);
  if (r.ok) assert.strictEqual(r.data.headline, "Buy shoes");
});

test("guard: invalid payload fails with structured issues (never throws)", async () => {
  const r = await guard(Ad, '{"headline":"This headline is definitely way too long for google"}');
  assert.ok(!r.ok);
  if (!r.ok) assert.ok(r.issues.some((i) => i.includes("headline")));
});

test("guardWithReprompt: heals within budget (char limits)", async () => {
  const calls: Array<string | undefined> = [];
  const out = await guardWithReprompt(Ad, async (hint) => {
    calls.push(hint);
    return hint === undefined
      ? '{"headline":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","desc":"ok"}'
      : '{"headline":"Short ad","desc":"ok"}';
  }, 2);
  assert.strictEqual(out.headline, "Short ad");
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1]?.includes("headline"), "reprompt must carry the exact structural error");
});

test("guardWithReprompt: exhausts budget then throws SchemaGuardError (never unvalidated data)", async () => {
  let calls = 0;
  await assert.rejects(
    guardWithReprompt(Ad, async () => { calls++; return '{"headline":"' + "x".repeat(40) + '"}'; }, 1),
    (err: unknown) => {
      assert.ok(err instanceof SchemaGuardError);
      assert.strictEqual((err as SchemaGuardError).attempts, 2);
      return true;
    },
  );
  assert.strictEqual(calls, 2, "bounded: exactly 1 initial + 1 reprompt");
});
