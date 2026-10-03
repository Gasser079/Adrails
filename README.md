# Adrails — Edge-Native Google Ads Management & Operating System

Adrails is a TypeScript monorepo that turns Google Ads accounts from manual
marketing interfaces into programmable, intelligent infrastructure — built on
Cloudflare Workers (Hono), D1, Queues, KV, Vectorize, and the Google Ads
**REST API v25**. No developer tokens (sunset 2026-09-09): access lives on the
Google Cloud project via per-tenant OAuth2.

```
              [ Client Applications / Event Sources ]
                                 │
                                 ▼  (Webhook / REST)
                ┌──────────────────────────────────┐
                │        Adrails Cloudflare Edge   │
                │  ┌────────────────────────────┐  │
                │  │     Hono Gateway Worker    │  │
                │  └──────────────┬─────────────┘  │
                │                 │                │
                │                 ▼                │
                │  ┌────────────────────────────┐  │
                │  │  Cloudflare D1 (SQL Engine)│  │
                │  └──────────────┬─────────────┘  │
                └─────────────────┼────────────────┘
                                  │
                                  ▼  (REST v25)
                 ┌──────────────────────────┐
                 │     Google Ads API v25   │
                 └──────────────────────────┘
```

## Core principles

- **Deterministic vs. probabilistic boundary.** API execution, monetary updates,
  structural mutations, and state live in strict, validated, deterministic code.
  LLMs do intent mapping, synthesis, diagnostics — and never mutate accounts.
- **The Golden Rule.** An LLM never touches an account directly. Every proposed
  mutation is a schema-validated payload in the immutable Action Ledger
  (`PROPOSED → VALIDATED → APPROVED → DISPATCHED → EXECUTED`) before dispatch.
- **Three-tier models.** Tier 1 cheap classifiers (Workers AI), Tier 2 frontier
  strategists (via Cloudflare AI Gateway), Tier 3 embeddings (bge-small-en →
  Vectorize).
- **Multi-client by design.** One agency tenant acts across many client accounts
  via MCC dual-ID: `login-customer-id` header (manager) + `{customerId}` path
  (target). New clients appear automatically once linked under the MCC.

## Monorepo topology (pnpm workspaces)

```
Adrails/
├── apps/
│   ├── worker-api/          # Hono delivery: health, ledger, L1 strategy (read-only)
│   ├── worker-execution/    # Queue consumer: approved-ledger dispatch (Stage 2+)
│   ├── audit-worker/        # L3 governance: telemetry, drift, recommendations (Stage 2+)
│   └── expert-agent/        # Cloud Ads expert: Discovery-grounded reads (41 v25 tools,
│                            #   mutates excluded) + ledger-gated writes; brain chain
│                            #   Groq gpt-oss-120b → qwen3.8 → Workers AI hermes
├── packages/
│   ├── ads-client/          # F1 Rate Shield & Auth Proxy (REST v25, OAuth2, dual-ID)
│   ├── ai-middleware/       # F2 AI Gateway client, tier router, Zod schema guard
│   ├── action-ledger/       # F3 D1 repository, state transitions, risk tiers
│   └── shared-types/        # System contracts (dual-ID, proposals, errors)
├── migrations/              # D1 SQL: 0001_action_ledger, 0002_tenant_oauth
├── brand/                   # Logo (SVG + PNG) for OAuth consent/brand verification
└── pnpm-workspace.yaml
```

Dependency rule: `delivery → domain → core`. Core never imports domain logic.

## Capabilities

1. **Google Ads REST v25 client (`@adrails/ads-client`)** — GAQL search/searchStream,
   atomic `googleAds:mutate`, keyword ideas + historical/forecast metrics,
   `uploadClickConversions`, customer management. OAuth2 per tenant, digit-only
   customer IDs (dashes rejected at validation), `ListAccessibleCustomers`
   discovery exception, exponential backoff with jitter, per-customer 1-QPS
   keyword-planning gate, KV response cache, deterministic error taxonomy
   (incl. `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` → console guidance).
2. **Action Ledger (`@adrails/action-ledger`)** — D1-backed state engine with
   legal-transition enforcement, append-only audit events, idempotency keys, and
   deterministic risk tiers (low auto / medium notify / high human-gated).
3. **AI middleware (`@adrails/ai-middleware`)** — gateway client with JSON-schema
   response mode, task→tier routing, Zod validation barrier with bounded
   re-prompt (fails closed, never returns unvalidated data).

## Environment & configuration

| Variable | Type | Scope | Description |
|---|---|---|---|
| `GOOGLE_ADS_CLIENT_ID` | Secret | Worker Secrets | GCP OAuth client ID |
| `GOOGLE_ADS_CLIENT_SECRET` | Secret | Worker Secrets | GCP OAuth client secret |
| `GOOGLE_ADS_REFRESH_TOKEN` | Secret | Worker Secrets (per tenant) | OAuth refresh token |
| `GOOGLE_ADS_CUSTOMER_ID` | Plain | Env / D1 | Target client account (digits only) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Plain | Env / D1 | Manager (MCC) account (digits only) |
| `LEDGER_DB` | D1 binding | Worker namespace | `adrails-ledger` database |
| `CACHE` | KV binding | Worker namespace | Forecast/discovery + token cache |
| `EXECUTION_QUEUE` | Queue binding | Worker namespace | Approved-mutation dispatch |
| `SEMANTIC_INDEX` | Vectorize binding | Worker namespace | Tier-3 semantic index |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Secret | Gateway / Secrets | Tier-2 provider keys (per deployment) |

No developer token is used or accepted anywhere in this codebase.

## Getting started

Prerequisites: Node.js ≥ 22.5, pnpm ≥ 12, Wrangler CLI, a Google Cloud project
with Google Ads API access (Explorer/Basic/Standard), and a manager (MCC) account.

```bash
git clone https://github.com/Gasser079/Adrails.git
cd Adrails
pnpm install
cp .dev.vars.example .dev.vars   # then fill in your OAuth + Cloudflare values
pnpm -r run build
pnpm -r --if-present run test
```

Onboard the agency tenant (lists every account your MCC login can open):

```bash
curl -X POST http://127.0.0.1:8787/v1/strategy/account-discovery \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"agency","loginCustomerId":"<YOUR_MCC_DIGITS>"}'
```

Propose a ledger action (example: safe audit action, no money touched):

```bash
curl -X POST http://127.0.0.1:8787/v1/ledger/propose \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"agency","customerId":"<ID>","actionType":"audit.account","requestId":"r1","scope":"customers/<ID>","payload":{},"createdBy":"USER_EXPLICIT"}'
```

## Deployment

```bash
# Remote database migrations first (cf tracks applied state; idempotent)
cf d1 migrations apply <D1-database-id> --dir ./migrations
# Secrets (never in code or D1 plaintext; value via env var, never literal)
cf workers secrets update GOOGLE_ADS_REFRESH_TOKEN --text "$VALUE" --type secret_text --worker adrails-api
# Deploy (wrangler still owns dev/deploy for JS workers during the cf beta)
pnpm --filter @adrails/worker-api run deploy
```

Tool split: `cf` for API operations, listings, and status (JSON-first);
wrangler for `dev` / `deploy` / `secret put` interactivity. See `SYSTEM-REPORT.md`
for the full runbook.

Live production deployment: `https://adrails-api.zozocawanozo.workers.dev`

## Security & reliability standards

- **Secrets discipline.** Refresh tokens and client secrets live in Worker Secrets
  (Cloudflare-encrypted) or local gitignored files. D1 holds non-secret metadata
  only. Repos carry zero credentials; CI fails on literal-secret patterns.
- **Human-gated mutations.** High-risk actions require explicit approval; the state
  machine rejects illegal transitions (e.g. `PROPOSED → EXECUTED` skips are
  impossible by construction).
- **Deterministic failure handling.** Provider errors map to
  (category, retryable, breaker) triples; retryable faults back off with jitter;
  idempotency keys make mutates double-submit safe.
- **Edge sandboxing.** Execution runs in isolated Cloudflare V8 isolates; no
  cross-request state.

## License

MIT — see [LICENSE](LICENSE).
