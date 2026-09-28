-- Adrails 0002: tenant OAuth metadata (non-secret) + managed client registry.
-- Secrets (refresh/access tokens) live in Worker Secrets or the agency's
-- credential files — never in these tables.
CREATE TABLE IF NOT EXISTS oauth_meta (
  tenant_id          TEXT PRIMARY KEY,
  login_customer_id  TEXT NOT NULL,
  account_email      TEXT,
  scopes             TEXT NOT NULL,
  project_id         TEXT,
  token_source       TEXT NOT NULL DEFAULT 'file',
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS managed_clients (
  tenant_id     TEXT NOT NULL,
  customer_id   TEXT NOT NULL,
  resource_name TEXT NOT NULL,
  discovered_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_id, customer_id)
);
CREATE INDEX IF NOT EXISTS idx_clients_tenant ON managed_clients(tenant_id);
