// @adrails/worker-api/routes/health
import { Hono } from "hono";
import type { AdrailsDeps } from "../env.js";

export function healthRoutes(_deps: AdrailsDeps): Hono {
  const app = new Hono();
  app.get("/health", (c) =>
    c.json({ status: "ok", service: "adrails-api", apiVersion: "v25", ts: new Date().toISOString() }),
  );
  return app;
}
