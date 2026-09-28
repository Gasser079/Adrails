// @adrails/worker-api — Hono delivery entrypoint (fetch handler for Workers).
import { Hono } from "hono";
import { ZodError } from "zod";
import { buildDeps, type AdrailsEnv, type AdrailsDeps } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { strategyRoutes } from "./routes/strategy.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { webhookRoutes } from "./routes/webhooks.js";

export function createApp(deps: AdrailsDeps): Hono {
  const app = new Hono();
  app.route("/", healthRoutes(deps));
  app.route("/", strategyRoutes(deps));
  app.route("/", ledgerRoutes(deps));
  app.route("/", webhookRoutes(deps));
  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ error: "validation", issues: err.issues }, 400);
    console.error("adrails-api error:", err);
    return c.json({ error: "internal" }, 500);
  });
  return app;
}

export default {
  async fetch(request: Request, env: AdrailsEnv): Promise<Response> {
    return createApp(buildDeps(env)).fetch(request);
  },
};
