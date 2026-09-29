-- Adrails 0003: audit findings (L3 governance).
-- Append-only: the audit worker records what it observed, never mutates it.
-- Triage of a finding happens through the Action Ledger, not here.
CREATE TABLE IF NOT EXISTS audit_findings (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('drift','policy','anomaly','recommendation')),
  severity    TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  summary     TEXT NOT NULL,
  details     TEXT,
  ledger_id   TEXT REFERENCES action_ledger(id),
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_findings_tenant_ct ON audit_findings(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_kind ON audit_findings(kind);
