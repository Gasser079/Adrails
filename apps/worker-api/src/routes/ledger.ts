// @adrails/worker-api/routes/ledger — the Golden Rule surface.
// Mutations enter as PROPOSED only. No route dispatches an external write.
import { Hono } from "hono";
import { z } from "zod";
import { CustomerIdSchema } from "@adrails/shared-types";
import { evaluateRiskWithClef } from "@adrails/action-ledger";
import type { AdrailsDeps } from "../env.js";

const ProposeInput = z.object({
  tenantId: z.string().min(1),
  customerId: CustomerIdSchema,
  actionType: z.string().min(1),
  requestId: z.string().min(1),
  scope: z.string().min(1),
  payload: z.unknown(),
  createdBy: z.enum(["SYSTEM_AI", "USER_EXPLICIT", "AUTOMATION"]),
  idempotencyKey: z.string().optional(),
});

const DecideInput = z.object({
  actor: z.string().min(1),
  reason: z.string().optional(),
});

export function ledgerRoutes(deps: AdrailsDeps): Hono {
  const app = new Hono();

  app.post("/v1/ledger/propose", async (c) => {
    const input = ProposeInput.parse(await c.req.json());
    // Clef risk model is opt-in (RISK_MODEL=clef) and fail-closed: any error
    // falls back to the deterministic regex tiers. Default behavior unchanged.
    let risk: { score: number; tier: "low" | "medium" | "high" } | undefined;
    if (deps.riskModel === "clef" && deps.ai) {
      try {
        const judged = await evaluateRiskWithClef(
          deps.ai,
          input.actionType,
          JSON.stringify(input.payload).slice(0, 500),
        );
        risk = { score: judged.score, tier: judged.tier };
      } catch (err) {
        console.error("clef risk fallback to rules:", err);
      }
    }
    const rec = await deps.ledger.record(
      {
        tenantId: input.tenantId,
        customerId: input.customerId,
        actionType: input.actionType,
        requestId: input.requestId,
        scope: input.scope,
        payload: input.payload,
        createdBy: input.createdBy,
        idempotencyKey: input.idempotencyKey,
      },
      risk ? { risk } : undefined,
    );
    return c.json(rec, 201);
  });

  app.get("/v1/ledger/pending", async (c) => {
    const tenantId = c.req.query("tenantId");
    if (!tenantId) return c.json({ error: "tenantId query param required" }, 400);
    return c.json({ pending: await deps.ledger.pendingByTenant(tenantId) });
  });

  app.get("/v1/ledger/:id", async (c) => {
    const rec = await deps.ledger.getById(c.req.param("id"));
    return rec ? c.json(rec) : c.json({ error: "not found" }, 404);
  });

  app.post("/v1/ledger/:id/validate", async (c) => {
    const input = DecideInput.parse(await c.req.json());
    return c.json(await deps.ledger.transition(c.req.param("id"), "VALIDATED", input.actor, input.reason));
  });

  app.post("/v1/ledger/:id/approve", async (c) => {
    const input = DecideInput.parse(await c.req.json());
    const id = c.req.param("id");
    const approved = await deps.ledger.transition(id, "APPROVED", input.actor, input.reason);
    // Golden Rule, second half: an approved row must leave the API only as a
    // queue message. The execution worker (sole mutator) picks it up from there.
    try {
      await deps.queue.send({ ledgerId: id, tenantId: approved.tenantId, customerId: approved.customerId });
    } catch (err) {
      return c.json({ status: approved.status, error: "enqueue_failed, row stays APPROVED and retryable" }, 502);
    }
    return c.json(await deps.ledger.transition(id, "DISPATCHED", "dispatcher", "enqueued for execution"));
  });

  app.post("/v1/ledger/:id/reject", async (c) => {
    const input = DecideInput.parse(await c.req.json());
    return c.json(await deps.ledger.transition(c.req.param("id"), "REJECTED", input.actor, input.reason));
  });

  return app;
}
