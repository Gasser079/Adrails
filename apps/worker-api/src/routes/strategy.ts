// @adrails/worker-api/routes/strategy — LEVEL 1 read-only intelligence.
// No writes. Every call is a dual-ID GET/POST read through the Rate Shield.
import { Hono } from "hono";
import { z } from "zod";
import { TenantScopeSchema, CustomerIdSchema } from "@adrails/shared-types";
import type { AdrailsDeps } from "../env.js";

const DiscoveryInput = z.object({
  tenantId: z.string().min(1),
  /** Manager (MCC) id that owns this tenant — digits only, never dashes. */
  loginCustomerId: CustomerIdSchema,
  accountEmail: z.string().email().optional(),
});
const IdeasInput = TenantScopeSchema.pick({ tenantId: true }).extend({
  customerId: CustomerIdSchema,
  body: z.record(z.unknown()),
});
const GaqlInput = TenantScopeSchema.pick({ tenantId: true }).extend({
  customerId: CustomerIdSchema,
  query: z.string().min(1).max(10000),
});

export function strategyRoutes(deps: AdrailsDeps): Hono {
  const app = new Hono();

  // Onboarding / discovery loop (the listAccessibleCustomers exception: raw OAuth).
  // Persists the tenant manager + every discovered client: the authoritative
  // "accounts under management" record. Read-only against Google.
  app.post("/v1/strategy/account-discovery", async (c) => {
    const input = DiscoveryInput.parse(await c.req.json());
    const names = await deps.ads.listAccessibleCustomers(input.tenantId);
    await deps.tenant.upsertTenant({
      tenantId: input.tenantId,
      loginCustomerId: input.loginCustomerId,
      accountEmail: input.accountEmail,
      scopes: "https://www.googleapis.com/auth/adwords",
      tokenSource: "agency-credential-files",
    });
    const clients = names.map((resourceName) => ({
      customerId: resourceName.replace(/^customers\//, ""),
      resourceName,
    }));
    const stored = await deps.tenant.replaceClients(input.tenantId, clients);
    return c.json({
      manager: input.loginCustomerId,
      clients: await deps.tenant.listClients(input.tenantId),
      stored,
    });
  });

  app.post("/v1/strategy/keyword-ideas", async (c) => {
    const input = IdeasInput.parse(await c.req.json());
    const results = await deps.ads.generateKeywordIdeas(input.tenantId, input.customerId, input.body as Record<string, unknown>);
    return c.json({ results });
  });

  app.post("/v1/strategy/gaql", async (c) => {
    const input = GaqlInput.parse(await c.req.json());
    const results = await deps.ads.searchGaql({ tenantId: input.tenantId, customerId: input.customerId, query: input.query });
    return c.json({ results });
  });

  return app;
}
