// @adrails/worker-api/routes/webhooks — approval delivery (human gates).
// Webhook approvals are just another actor path into the ledger transition map.
import { Hono } from "hono";
import { z } from "zod";
import type { AdrailsDeps } from "../env.js";

const ApprovalInput = z.object({
  decision: z.enum(["approve", "reject"]),
  actor: z.string().min(1),
  reason: z.string().optional(),
});

export function webhookRoutes(deps: AdrailsDeps): Hono {
  const app = new Hono();
  app.post("/webhooks/approval/:id", async (c) => {
    const input = ApprovalInput.parse(await c.req.json());
    const to = input.decision === "approve" ? "APPROVED" : "REJECTED";
    return c.json(await deps.ledger.transition(c.req.param("id"), to, input.actor, input.reason));
  });
  return app;
}
