# Adrails — AI-Augmented Google Ads Management & Operating System

Deterministic Google Ads API execution + probabilistic AI agents, separated by an
immutable Action Ledger. Cloudflare Workers + Hono + D1 + Queues + KV + Vectorize.

## Layout (Pattern A monorepo, dependency rule: delivery → domain → core)

- `packages/ads-client` — F1: Rate Shield & Auth Proxy (REST v25, OAuth2 per-tenant,
  dual-ID `login-customer-id` + `{customerId}`, 429 backoff, KV cache)
- `packages/ai-middleware` — F2: AI Gateway client, Tier 1/2/3 router, Zod schema guard
  with bounded re-prompt
- `packages/action-ledger` — F3: D1 repository, `PROPOSED→VALIDATED→APPROVED→
  DISPATCHED→EXECUTED` lifecycle, deterministic risk tiers
- `packages/shared-types` — system contracts (dual-ID, proposals, errors)
- `apps/worker-api` — Hono delivery: health, ledger, L1 strategy (read-only)
- `apps/worker-execution` — Queue consumer (Stage 2+ dispatch)
- `apps/audit-worker` — L3 governance (Stage 2+ rollout)
- `migrations/0001_action_ledger.sql` — D1 schema

## Commands

```bash
pnpm install
pnpm -r run build
pnpm -r --if-present run test
```

## Rules that must never break

1. An LLM never mutates an account directly — every mutation is a ledger proposal.
2. Secrets live in Worker Secrets. Dev tokens are never sent (sunset 2026-09-09).
3. Customer ids are digits-only; dashes are rejected at validation.
