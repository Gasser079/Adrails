// @adrails/worker-execution — Queue consumer: the ONLY path that mutates Google.
// Contract per message { ledgerId, tenantId, customerId }:
//   row missing/terminal         -> ack (skip, already settled)
//   row not APPROVED/DISPATCHED  -> throw (bounded retries -> DLQ for review)
//   mutate ok                    -> EXECUTED + ack
//   mutate fails, non-retryable  -> FAILED + ack
//   mutate fails, retryable      -> throw (Queue redelivers; DLQ after max_retries)
import { AdsApiError } from "@adrails/ads-client";
import type { ExecutionDeps } from "./env.js";

export interface DispatchMessage {
  ledgerId: string;
  tenantId: string;
  customerId: string;
}

interface QueueMessage<T> {
  body: T;
  ack(): void;
  retry(): void;
}

interface QueueBatch<T> {
  messages: Array<QueueMessage<T>>;
}

export async function handleDispatchBatch(batch: QueueBatch<DispatchMessage>, deps: ExecutionDeps): Promise<void> {
  for (const msg of batch.messages) {
    await dispatchOne(msg.body, deps);
    msg.ack();
  }
}

async function dispatchOne(m: DispatchMessage, deps: ExecutionDeps): Promise<void> {
  const rec = await deps.ledger.getById(m.ledgerId);
  if (!rec) return; // unknown row: nothing to do
  if (rec.status === "EXECUTED" || rec.status === "FAILED" || rec.status === "REJECTED" || rec.status === "EXPIRED") return;
  if (rec.status !== "APPROVED" && rec.status !== "DISPATCHED") {
    throw new Error(`dispatch_unexpected_state: ${rec.status} (ledger ${m.ledgerId})`);
  }
  if (rec.status === "APPROVED") {
    await deps.ledger.transition(m.ledgerId, "DISPATCHED", "dispatcher", "picked up from queue");
  }
  const payload = rec.payload as { mutate_operations?: unknown[] };
  if (!Array.isArray(payload?.mutate_operations)) {
    await deps.ledger.transition(m.ledgerId, "FAILED", "dispatcher", "payload lacks mutate_operations[]");
    return;
  }
  try {
    const res = await deps.ads.mutate(m.tenantId, m.customerId, payload.mutate_operations);
    const summary = JSON.stringify(res).slice(0, 500);
    await deps.ledger.transition(m.ledgerId, "EXECUTED", "dispatcher", `google accepted: ${summary}`);
  } catch (err) {
    if (err instanceof AdsApiError && !err.retryable) {
      await deps.ledger.transition(m.ledgerId, "FAILED", "dispatcher", `[${err.category}] ${err.message}`.slice(0, 500));
      return;
    }
    throw err; // retryable or unknown -> Queue redelivery, DLQ after max_retries
  }
}

export default {
  async queue(batch: QueueBatch<DispatchMessage>, env: unknown): Promise<void> {
    const { buildExecutionDeps } = await import("./env.js");
    await handleDispatchBatch(batch, buildExecutionDeps(env as Parameters<typeof buildExecutionDeps>[0]));
  },
};
