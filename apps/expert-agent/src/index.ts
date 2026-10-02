// @adrails/expert-agent — HTTP entry: per-tenant Durable Object instances.
// POST /v1/expert/:tenantId/ask { question } -> grounded answer + chase block.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z, ZodError } from "zod";
import { ExpertAgent } from "./expert-agent.js";

export { ExpertAgent };

interface ExpertBindings {
  EXPERT_AGENT: {
    idFromName(name: string): unknown;
    get(id: unknown): { ask(input: { tenantId: string; question: string }): Promise<unknown> };
  };
}

const AskInput = z.object({ question: z.string().min(1).max(4000) });

export function createExpertApp(): Hono {
  const app = new Hono();
  // Short-term: open CORS for the owner's browser smoke page (revisit with auth).
  app.use("/*", cors({ origin: "*" }));
  app.get("/health", (c) => c.json({ status: "ok", service: "adrails-expert", apiVersion: "v25" }));
  app.post("/v1/expert/:tenantId/ask", async (c) => {
    const input = AskInput.parse(await c.req.json());
    const tenantId = c.req.param("tenantId");
    const ns = (c.env as unknown as ExpertBindings).EXPERT_AGENT;
    const stub = ns.get(ns.idFromName(`expert-${tenantId}`));
    return c.json(await stub.ask({ tenantId, question: input.question }));
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: "validation", issues: err.issues }, 400);
    console.error("adrails-expert error:", err);
    return c.json({ error: "internal" }, 500);
  });
  return app;
}

export default {
  async fetch(request: Request, env: unknown): Promise<Response> {
    return createExpertApp().fetch(request, env as never);
  },
};
