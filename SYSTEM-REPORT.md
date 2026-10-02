# Adrails — System Report

> The single document that explains Adrails end to end: what it is, what it's
> made of, how it works, where it runs, how it's verified, and what's next.
> Written for humans and AI agents alike. No secrets inside — safe to share.

## 1. What Adrails is

**One sentence:** Adrails is an AI-augmented operating system for managing
Google Ads client accounts — software that watches, plans, and (only with human
approval) acts on many ad accounts, running 24/7 on Cloudflare's edge.

**The problem it solves:** managing several client accounts by hand means
logging into each one, checking performance, writing copy, adjusting budgets,
and catching what breaks — during working hours, inconsistently. Things slip:
tracking breaks quietly, budgets drift, policies disapprove ads unnoticed.
Adrails replaces that manual loop with a tireless machine layer while keeping a
human as the decision-maker.

**The three levels** (each holds micro-levels — strategy first, then execution,
then oversight):

| Level | Name | Job | Risk |
|---|---|---|---|
| L1 | Strategy & Planning | Read-only intelligence: demand, forecasts, audits, account health | Zero — never writes |
| L2 | Execution & Deployment | Ledger-gated mutations: campaigns, budgets, assets, conversions | High — human approval required |
| L3 | Monitoring & Governance | 24/7 watchdog: telemetry, policy, drift, recommendations | Zero writes to Google; writes findings + proposals only |

**Three inviolable principles:**

1. **Deterministic vs. probabilistic boundary.** API execution, money, and state
   are strict validated code. LLMs do intent, synthesis, and diagnosis only.
2. **The Golden Rule.** An LLM never mutates an account directly. Every proposed
   change is a schema-validated payload in the immutable Action Ledger and moves
   `PROPOSED → VALIDATED → APPROVED → DISPATCHED → EXECUTED` before anything
   touches Google.
3. **Three-tier models.** Tier 1 cheap classifiers (Workers AI), Tier 2 frontier
   strategists (via AI Gateway / Groq), Tier 3 embeddings (local MiniLM for the
   dev knowledge base).

**Repo:** `https://github.com/Gasser079/Adrails` (TypeScript pnpm monorepo,
Pattern A: `packages/` shared infrastructure, `apps/` deployable workers).
Dependency rule: `delivery → domain → core`; core never imports domain logic.

## 2. Components

### 2.1 `packages/shared-types` — system contracts
Zod schemas shared by every package: digit-only customer IDs (dashes rejected —
Google rejects them in headers), the dual-ID tenant scope
(`loginCustomerId` + `customerId`), the action lifecycle enum, risk tiers, the
OAuth context shape, and the normalized provider-error categories.

### 2.2 `packages/ads-client` (F1) — Rate Shield & Auth Proxy
The only path to Google. Contents:

- `auth.ts` — OAuth2 user-auth flow (client ID/secret + refresh token); token
  refresh against Google; **no developer token anywhere** (sunset 2026-09-09;
  access lives on the Google Cloud project that owns the OAuth client).
- `file-credentials.ts` — runtime loader for an existing on-disk credential set
  (local/dev path): read-only load, auto-refresh with skew, memory + KV cache,
  clear consent-fix guidance on `invalid_grant`. Accepts `web` and `installed`
  secret shapes.
- `headers.ts` — the MCC **dual-ID** contract: `login-customer-id` header
  (manager MCC) + `{customerId}` in path/body (target client). Exception:
  `customers:listAccessibleCustomers` (parameter-less GET, raw OAuth only).
- `errors.ts` — ported failure taxonomy mapping Google/gRPC/REST errors to
  `(category, retryable, breaker)` triples, extended with
  `CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` → console guidance; `AdsApiError`
  preserves the classified prefix in its message.
- `endpoints.ts` — REST v25 paths verified against the fetched discovery
  document (search, searchStream, mutate, keyword ideas/history/forecast,
  conversion uploads, customer management).
- `rate.ts` — exponential backoff with jitter, per-customer 1-QPS gate for
  keyword-planning endpoints, pluggable KV response cache.
- `client.ts` — `GoogleAdsRestClient` (Workers-native `fetch`): discovery,
  GAQL search (cached), atomic mutate, keyword planning (gated), conversion
  upload. Auto-mints access tokens from the refresh triple (memory + KV cache)
  when only secrets are present (the Worker path).

### 2.3 `packages/ai-middleware` (F2) — Schema-Enforced AI Middleware
- `gateway.ts` — Cloudflare AI Gateway client (provider auth, JSON-schema
  response mode, usage passthrough).
- `tiers.ts` — task→tier router (classify/parse → Tier 1, strategize/copywrite/
  diagnose → Tier 2, embed → Tier 3) with swappable model table.
- `schema-guard.ts` — deterministic validation barrier: every LLM output that
  can become an action is Zod-validated; failures trigger a bounded re-prompt
  (≤2) carrying the exact structural error; exhaustion throws
  `SchemaGuardError` — unvalidated data never passes.

### 2.4 `packages/action-ledger` (F3) — ledger, tenants, findings
- `repository.ts` — D1-backed `ActionLedgerRepository` over a minimal `D1Like`
  port (real D1 in Workers, `node:sqlite` in tests): record/get/pending/
  transition with legal-move enforcement + audit-event append.
- `transitions.ts` — the canonical lifecycle map (including `VALIDATED`,
  `INVALIDATED`, `EXPIRED`; terminal states are terminal; `FAILED` may retry to
  `DISPATCHED`) + deterministic risk tiers (structural/monetary/bulk → high;
  reads/drafts → low; else medium).
- `tenant.ts` — `TenantRepository`: per-tenant OAuth metadata (non-secret) +
  managed-client registry (authoritative replace per discovery run).
- `audit.ts` — append-only `AuditFindingsRepository` (drift/policy/anomaly/
  recommendation, info/warning/critical, optional ledger link).

### 2.5 `apps/worker-api` — Hono delivery
Routes: `GET /health`; L1 read-only `POST /v1/strategy/{account-discovery,
keyword-ideas,gaql}` (never touch the ledger); ledger `POST /v1/ledger/propose`,
`GET /v1/ledger/pending`, `GET /v1/ledger/:id`, `POST .../validate|approve|
reject`; `POST /webhooks/approval/:id`. Approving enqueues to
`EXECUTION_QUEUE` and moves the row to `DISPATCHED` (enqueue failure → 502,
row stays retryable `APPROVED`). Zod errors → 400. Short-term open CORS
(revisit with team auth).

### 2.6 `apps/worker-execution` — the sole mutator
Queue consumer. Per message `{ledgerId, tenantId, customerId}`: skip settled
rows; throw on unexpected states (bounded retries → DLQ); require
`APPROVED`/`DISPATCHED`; execute `mutate_operations` via the client;
`EXECUTED` on success; validation-classified failures → `FAILED` (no retry
storm); transient failures → rethrow (redelivery). Payloads without
`mutate_operations[]` fail closed without ever calling Google.

### 2.7 `apps/audit-worker` — the watchdog (cron, every 30 min)
For every tenant and managed client: **drift scan** (recent `change_event`
rows → info findings for reconciliation), **policy scan** (non-approved ads →
critical findings), **recommendation scan** (Google recommendations → `PROPOSED`
`triage` ledger rows + linked findings, never auto-applied). Per-client errors
are isolated. Read-only against Google; writes go to findings + ledger only.

### 2.8 `apps/expert-agent` — the cloud Ads expert
Agents SDK `Agent` on a Durable Object (one instance per tenant): conversational
Google Ads expert grounded in the **live v25 Discovery contract**, not a vector
store (knowledge bases deprecated for cloud by owner decision).
- `scripts/compile-discovery-tools.mjs` flattens the v25 discovery doc into a
  typed tool catalog at build time — **41 read-only tools; every mutating
  method excluded by construction** (test-enforced).
- Brain chain with automatic failover: Groq `gpt-oss-120b` → `qwen3.8-27b` →
  Workers AI Hermes. Max 6 reasoning turns; honest escalation when ungrounded.
- Tools: trimmed Discovery reads (top-12 by question overlap) + always-present
  ledger tools (`propose_ledger_action`, `ledger_status`); tenant-scoped,
  managed-clients-only, digits-validated.
- Entry: `POST /v1/expert/:tenantId/ask` → `{reply_text, chase{status,
  confidence, citations, gap_reason?, tenant_id}}`.
- `brand/` holds the Adrails logo (SVG + PNG) for OAuth consent/brand verification.

### 2.9 Local knowledge system (dev path, kept — not deleted)
The original broker-side library stays for development/offline use: global
`knowledge-registry.json`, per-domain `knowledge-map.json`, 16 present
partitions (15 doc partitions + `googleads_v25_schema_vectors`, 2,607 units
flattened from the v25 discovery doc), `knowledge_service.{map,extract,
answer}` connector with grant projection, confidence gating, deepen-or-gap, and
`@google-ads-expert` as the local conversational consumer. Stores live as local
SQLite (gitignored); scripts for flatten/embed/verify are committed.

## 3. How it works (the flows)

### 3.1 Agency onboarding (once per manager)
1. OAuth consent (one click by the owner) → tokens stored (local files for dev,
   Worker Secrets in cloud).
2. `POST /v1/strategy/account-discovery {tenantId, loginCustomerId}` →
   `GET customers:listAccessibleCustomers` (raw OAuth, the one exception) →
   returns every accessible account.
3. Tenant row (`login_customer_id`) + managed-client set persisted in D1
   (authoritative replace per run). New UI-linked clients appear on the next run;
   nothing per-client is ever configured.

### 3.2 Asking the cloud expert
`POST /v1/expert/:tenantId/ask {question}` → tenant resolved from D1 →
question-trimmed tool shortlist → brain loop (read tools → ledger tools if an
action is requested) → conversational Markdown answer with method-path
citations + confidence + machine chase block. Unknown tenants, missing OAuth,
dead brains, and empty grounding all escalate honestly instead of fabricating.

### 3.3 Proposing and executing a change (the Golden Rule in motion)
1. `POST /v1/ledger/propose` → `PROPOSED` (+ risk tier) — from UI, agent, or audit.
2. `POST .../validate` → `VALIDATED` (schema/policy gate).
3. `POST .../approve` (or approval webhook) → `APPROVED` → enqueue →
   `DISPATCHED`. Enqueue failure leaves the row retryably `APPROVED`.
4. Execution worker consumes → Google `mutate` → `EXECUTED` (+ operation
   summary) or `FAILED` (validation) or redelivery→DLQ (transient).
5. Every transition appends a `ledger_events` row; `pending` lists actionable rows.

### 3.4 Audit rhythm (every 30 min, all managed accounts)
Drift findings → reconcile; policy findings → fix or exempt; recommendations →
triage proposals. Humans decide; machines watch.

### 3.5 Auth model (post-sunset)
No developer tokens. Per-tenant OAuth2 user-auth (GCP project owns access;
`absolute-axis-260810` for the agency tenant). Dual-ID on every call
(`login-customer-id` = MCC, `{customerId}` = target; dashes rejected at
validation). RefreshChain: memory → KV → Google refresh; `invalid_grant` →
explicit re-consent guidance. Secrets live in Worker Secrets / gitignored
files; D1 holds identifiers only. New `CLOUD_PROJECT_NOT_APPROVED_FOR_
PRODUCTION` errors map to console remediation guidance, not silent failure.

## 4. Where it runs (verified production reality)

| Worker | URL | Current version | Since |
|---|---|---|---|
| `adrails-api` | `https://adrails-api.zozocawanozo.workers.dev` | `ee2d807a` | 2026-09-29 |
| `adrails-execution` | `https://adrails-execution.zozocawanozo.workers.dev` | `de220f62` | 2026-09-29 |
| `adrails-audit` | `https://adrails-audit.zozocawanozo.workers.dev` | `99256ecf` | 2026-09-29 |
| `adrails-expert` | `https://adrails-expert.zozocawanozo.workers.dev` | `dde8b47e` | 2026-10-02 |

Bindings (committed in `wrangler.jsonc`): D1 `adrails-ledger`, KV `CACHE`,
Queues `adrails-execution` (+ DLQ), Vectorize `adrails-semantic` (reserved),
`AI`, Durable Object `EXPERT_AGENT`, cron `*/30 * * * *` (audit). Secrets (6
per worker needing them): Google OAuth triple + both account IDs + Groq key
(expert only) — set via `wrangler secret put`, never in code.
Remote D1 census (verified): 4 ledger rows, 18 events, 4 managed clients,
0 findings. Migrations `0001_action_ledger`, `0002_tenant_oauth`,
`0003_audit_findings` applied remotely.

Note: this dev machine's egress filter blocks `workers.dev`, so live-URL
verification is done from unrestricted networks (owner-run smoke page).

## 5. Verification evidence

- **46 tests, 0 fail** (ai-middleware 6 · action-ledger 6 · ads-client 19 ·
  expert-agent 6 · execution 4 · audit 2 · api 3). Hermetic sqlite flags;
  fixture-only credentials.
- **Live ledger lifecycle, twice**: propose 201 `PROPOSED` → `VALIDATED` →
  `APPROVED` → auto-queued `DISPATCHED` → pending 0 — on production, owner-run.
- **Live discovery**: real `listAccessibleCustomers` returned the MCC + clients;
  tenant + client set persisted and re-read from remote D1.
- **Expert wiring tests**: broker identity path (map/extract/unauthorized gap);
  compiler test enforces the no-mutate-tools invariant; brain failover tested
  (429 → fallback → answer; full outage → explicit error).
- **Verifiers**: knowledge-map and registry verifiers PASS (16 present, dim 384).
- **CI gates** (broker origin): frozen install → build → test → secret/admission scans.

## 6. Security rules (non-negotiable, enforced)

1. LLMs never mutate directly — ledger only; mutating tools don't exist in the
   expert catalog by construction.
2. Secrets in Worker Secrets / gitignored files only; repos carry zero
   credentials (literal-secret discipline; account IDs scrubbed to fixtures).
3. Customer IDs digits-only, validated at every boundary.
4. Terminal states are terminal; illegal transitions throw; idempotency keys
   make mutates double-submit safe.
5. Short-term open CORS on `worker-api`/`expert-agent` is documented tech debt —
   replaced by Access/team auth, tracked openly.

## 7. Operations runbook (the commands that matter)

```bash
pnpm install && pnpm -r run build && pnpm -r --if-present run test
npx wrangler d1 execute adrails-ledger --remote --file=migrations/000N_*.sql
npx wrangler secret put NAME                  # paste value, never commit it
npx wrangler deploy                             # per app dir
npx wrangler deployments list                   # server-side truth of what's live
npx wrangler d1 execute adrails-ledger --remote --command="SELECT ..."
node --experimental-sqlite <script>             # required flag: shell sets NODE_OPTIONS=--no-experimental-sqlite
```

## 8. Open threads & roadmap

- **Done:** threads #1 (live ledger proof) · #2 (worker secrets + auto-refresh)
  · #3 (dispatcher + audit live) · #4 (v25 knowledge refresh).
- **Declined by owner:** #5 token rotation (risk accepted, recorded).
- **Open:** #6 OAuth app publishing + brand verification + Explorer/Basic access
  (business unlock; logo ready); one client account vanished from discovery
  between OAuth clients — flagged for UI verification (see ledger notes);
  subjects-hint for schema-exact expert questions; team logins (Access-first, no
  custom auth); short-term CORS replacement; single-account tenant scoping if a
  second agency onboard.
- **Stage 3 (future):** autonomous execution with exception safeguards;
  per-tenant D1 isolation option; Vectorize/lexical parity if cloud RAG returns.

## 9. Glossary

- **MCC / manager** — the agency's top-level Google Ads manager account; its ID
  goes in `login-customer-id` on every call.
- **Dual-ID** — `loginCustomerId` (who's asking) + `customerId` (who it's about).
- **Ledger** — the immutable proposal→execution record; the only path to mutation.
- **Knowledge path** — logical domain id (`google_ads_api`) an agent sends to
  resolve grounded knowledge; never a filesystem path.
- **Knowledge gap** — honest `status: knowledge_gap` with reason; queued for the
  pipeline, never papered over.
- **Tiers** — T1 cheap classifiers, T2 frontier strategists, T3 embeddings.
- **Golden Rule** — Section 1, principle 2. The whole system is this rule, enforced.
