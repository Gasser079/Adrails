// @adrails/expert-agent/tools — trimmer + executors.
// Discovery tools execute against Google REST with tenant OAuth (dual-ID).
// Ledger tools are the ONLY write path (PROPOSED rows for human triage).
import { DISCOVERY_TOOLS, type DiscoveryToolDef } from "./discovery-tools.generated.js";
import { GoogleAdsErrorMapper } from "@adrails/ads-client";
import { refreshAccessToken } from "@adrails/ads-client";
import { ActionLedgerRepository } from "@adrails/action-ledger";
import type { KvLike } from "@adrails/ads-client";
import type { ToolCall } from "./brain.js";

const ADS_REST_BASE = "https://googleads.googleapis.com/v25";

export interface ToolRuntime {
  tenantId: string;
  loginCustomerId: string;
  managedCustomerIds: string[];
  googleOAuth: { clientId: string; clientSecret: string; refreshToken: string };
  kv: KvLike | null;
  fetchFn?: typeof fetch;
  ledger: ActionLedgerRepository;
}

export interface ExecutedTool {
  name: string;
  ok: boolean;
  text: string;
  citation?: { method: string; path: string };
}

/** Per-turn trim: top-N discovery tools by token overlap + always the ledger tools. */
export function trimTools(question: string, topN = 12): DiscoveryToolDef[] {
  const toks = new Set(question.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2));
  const scored = DISCOVERY_TOOLS.map((d) => {
    const hay = `${d.name} ${d.description}`.toLowerCase().split(/[^a-z0-9]+/);
    let s = 0;
    for (const t of hay) if (toks.has(t)) s += t.length > 5 ? 2 : 1;
    // method-name fragments match harder (generateKeywordIdeas ~ "keyword ideas")
    for (const t of toks) if (d.name.toLowerCase().includes(t) && t.length > 5) s += 3;
    return { d, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, topN).map((x) => x.d);
}

export const LEDGER_TOOL_DEFS = [
  {
    name: "propose_ledger_action",
    description: "Record a proposed account change for human triage. The ONLY way to initiate a mutation. Returns the ledger id and risk tier.",
    parameters: {
      type: "object",
      properties: {
        actionType: { type: "string", description: "e.g. budget.update, campaign.create, recommendation.triage" },
        customerId: { type: "string", description: "digits-only target account" },
        scope: { type: "string", description: "e.g. customers/123" },
        payload: { type: "object", description: "action payload" },
        requestId: { type: "string", description: "caller correlation id" },
      },
      required: ["actionType", "customerId", "payload"],
    },
  },
  {
    name: "ledger_status",
    description: "Read the current state of a ledger row by id.",
    parameters: {
      type: "object",
      properties: { ledgerId: { type: "string", description: "ledger row id" } },
      required: ["ledgerId"],
    },
  },
];

async function accessToken(rt: ToolRuntime): Promise<string> {
  const key = `adrails:token:${rt.tenantId}`;
  if (rt.kv) {
    try {
      const cached = await rt.kv.get(key);
      if (cached) {
        const p = JSON.parse(cached) as { accessToken: string; expiresAtMs: number };
        if (p.expiresAtMs - Date.now() > 60_000) return p.accessToken;
      }
    } catch { /* fall through */ }
  }
  const bundle = await refreshAccessToken({
    fetchFn: rt.fetchFn ?? fetch,
    clientId: rt.googleOAuth.clientId,
    clientSecret: rt.googleOAuth.clientSecret,
    refreshToken: rt.googleOAuth.refreshToken,
  });
  if (rt.kv) {
    await rt.kv
      .put(key, JSON.stringify({ accessToken: bundle.accessToken, expiresAtMs: bundle.expiresAtMs }), { expirationTtl: 3500 })
      .catch(() => {});
  }
  return bundle.accessToken;
}

function resolveCustomer(rt: ToolRuntime, args: Record<string, unknown>): string {
  const c = args.customerId;
  if (typeof c === "string" && /^[0-9]{1,10}$/.test(c) && (c === rt.loginCustomerId || rt.managedCustomerIds.includes(c))) {
    return c;
  }
  return rt.loginCustomerId; // safe default: manager-level read
}

export async function executeDiscoveryTool(rt: ToolRuntime, def: DiscoveryToolDef, args: Record<string, unknown>): Promise<ExecutedTool> {
  try {
    const token = await accessToken(rt);
    const customerId = resolveCustomer(rt, args);
    let url = `${ADS_REST_BASE}/${def.path.replace("{+customerId}", customerId).replace("{customerId}", customerId)}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    // Dual-ID exception: listAccessibleCustomers carries no login header.
    if (!/listAccessibleCustomers/.test(def.path)) headers["login-customer-id"] = rt.loginCustomerId;
    let body: string | undefined;
    if (def.httpMethod === "GET") {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) {
        if (k === "customerId" || v === undefined || v === null) continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") qs.append(k, String(v));
      }
      const q = qs.toString();
      if (q) url += (url.includes("?") ? "&" : "?") + q;
    } else {
      const { customerId: _drop, ...rest } = args;
      body = JSON.stringify(rest);
    }
    const res = await (rt.fetchFn ?? fetch)(url, { method: def.httpMethod, headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const mapped = GoogleAdsErrorMapper.mapError({ code: res.status, message: text.slice(0, 300) });
      return { name: def.name, ok: false, text: `Google API ${res.status} [${mapped.category}]: ${mapped.message}${mapped.guidance ? ` Guidance: ${mapped.guidance}` : ""}` };
    }
    const json = (await res.json()) as unknown;
    return { name: def.name, ok: true, text: JSON.stringify(json).slice(0, 4000), citation: { method: def.name, path: def.path } };
  } catch (err) {
    return { name: def.name, ok: false, text: `tool_error: ${String((err as Error)?.message ?? err).slice(0, 300)}` };
  }
}

export async function executeLedgerTool(rt: ToolRuntime, call: ToolCall): Promise<ExecutedTool> {
  try {
    if (call.name === "propose_ledger_action") {
      const a = call.arguments as { actionType?: string; customerId?: string; scope?: string; payload?: unknown; requestId?: string };
      if (typeof a.actionType !== "string" || typeof a.customerId !== "string" || !/^[0-9]{1,10}$/.test(a.customerId)) {
        return { name: call.name, ok: false, text: "invalid arguments: actionType/customerId required, customerId digits-only" };
      }
      if (a.customerId !== rt.loginCustomerId && !rt.managedCustomerIds.includes(a.customerId)) {
        return { name: call.name, ok: false, text: `refused: ${a.customerId} is not managed under this tenant` };
      }
      const rec = await rt.ledger.record({
        tenantId: rt.tenantId,
        customerId: a.customerId,
        actionType: a.actionType,
        requestId: typeof a.requestId === "string" && a.requestId ? a.requestId : `expert-${Date.now().toString(36)}`,
        scope: typeof a.scope === "string" && a.scope ? a.scope : `customers/${a.customerId}`,
        payload: a.payload ?? {},
        createdBy: "SYSTEM_AI",
      });
      return { name: call.name, ok: true, text: `recorded ledger ${rec.id} status=${rec.status} risk=${rec.riskTier}. A human must approve before anything executes.` };
    }
    if (call.name === "ledger_status") {
      const id = (call.arguments as { ledgerId?: string }).ledgerId;
      if (typeof id !== "string") return { name: call.name, ok: false, text: "ledgerId required" };
      const rec = await rt.ledger.getById(id);
      if (!rec) return { name: call.name, ok: false, text: `unknown ledger id ${id}` };
      return { name: call.name, ok: true, text: `ledger ${id}: status=${rec.status} action=${rec.actionType} risk=${rec.riskTier}` };
    }
    return { name: call.name, ok: false, text: `unknown ledger tool ${call.name}` };
  } catch (err) {
    return { name: call.name, ok: false, text: `tool_error: ${String((err as Error)?.message ?? err).slice(0, 300)}` };
  }
}

export async function executeToolCall(
  rt: ToolRuntime,
  call: ToolCall,
  defs: Map<string, DiscoveryToolDef>,
): Promise<ExecutedTool> {
  if (call.name === "propose_ledger_action" || call.name === "ledger_status") {
    return executeLedgerTool(rt, call);
  }
  const def = defs.get(call.name);
  if (!def) return { name: call.name, ok: false, text: `unknown tool ${call.name} (not in trimmed catalog)` };
  return executeDiscoveryTool(rt, def, call.arguments);
}
