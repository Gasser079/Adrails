// @adrails/worker-api — Hono delivery entrypoint (fetch handler for Workers).
import { Hono } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { buildDeps, type AdrailsEnv, type AdrailsDeps } from "./env.js";
import { healthRoutes } from "./routes/health.js";
import { strategyRoutes } from "./routes/strategy.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { webhookRoutes } from "./routes/webhooks.js";

export function createApp(deps: AdrailsDeps): Hono {
  const app = new Hono();
  // Short-term: open CORS so the owner can drive the API from a local
  // browser page WITH the Access session cookie (credentialed requests need
  // an echoed origin — "*" is rejected by browsers). Revisit with team auth.
  app.use("/*", cors({ origin: (o) => o, credentials: true }));
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
