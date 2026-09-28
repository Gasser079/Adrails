-- Adrails 0001: Action Ledger core + audit + idempotency.
-- Every external mutation lands here as PROPOSED first; nothing dispatches without
-- a VALIDATED -> APPROVED path. Plain DDL only (D1 manages journaling itself).

CREATE TABLE IF NOT EXISTS action_ledger (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  customer_id          TEXT NOT NULL,
  action_type          TEXT NOT NULL,
  request_id           TEXT NOT NULL,
  scope                TEXT NOT NULL,
  payload              TEXT NOT NULL,
  payload_schema_version INTEGER NOT NULL DEFAULT 1,
  status               TEXT NOT NULL CHECK (status IN
                         ('PROPOSED','VALIDATED','APPROVED','DISPATCHED','EXECUTED','REJECTED','INVALIDATED','FAILED','EXPIRED')),
  risk_score           REAL NOT NULL DEFAULT 0.0,
  risk_tier            TEXT NOT NULL DEFAULT 'medium' CHECK (risk_tier IN ('low','medium','high')),
  requested_by         TEXT NOT NULL,
  approved_by          TEXT,
  rejection_reason     TEXT,
  policy_result        TEXT,
  idempotency_key      TEXT UNIQUE,
  api_endpoint         TEXT,
  google_operation_id  TEXT,
  dispatch_at          INTEGER,
  executed_at          INTEGER,
  error                TEXT,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at           INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_ledger_status ON action_ledger(status);
CREATE INDEX IF NOT EXISTS idx_ledger_tenant_ct ON action_ledger(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ledger_request ON action_ledger(request_id);

CREATE TABLE IF NOT EXISTS ledger_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_id   TEXT NOT NULL REFERENCES action_ledger(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT,
  note        TEXT,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_events_ledger ON ledger_events(ledger_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  ledger_id  TEXT REFERENCES action_ledger(id),
  expires_at INTEGER
);
