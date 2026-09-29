import test from "node:test";
import assert from "node:assert";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TenantRepository } from "../tenant.js";
import type { D1Like } from "../repository.js";

function memDb(): D1Like & { close(): void } {
  const db = new DatabaseSync(":memory:");
  const migDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "migrations");
  for (const f of ["0001_action_ledger.sql", "0002_tenant_oauth.sql"]) {
    db.exec(fs.readFileSync(path.join(migDir, f), "utf8"));
  }
  return {
    close: () => db.close(),
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        run: async () => db.prepare(sql).run(...(values as [])),
        first: async <T>() => {
          const rows = db.prepare(sql).all(...(values as [])) as unknown as T[];
          return rows[0] ?? null;
        },
        all: async <T>() => ({ results: db.prepare(sql).all(...(values as [])) as unknown as T[] }),
      }),
    }),
  };
}

test("tenant repo: upsert/get manager record, rejects dashed ids", async () => {
  const db = memDb();
  try {
    const repo = new TenantRepository(db);
    assert.strictEqual(await repo.getTenant("agency"), null);
    await repo.upsertTenant({
      tenantId: "agency", loginCustomerId: "1000000001", accountEmail: "owner@example.com",
      scopes: "https://www.googleapis.com/auth/adwords", tokenSource: "agency-credential-files",
    });
    const got = await repo.getTenant("agency");
    assert.strictEqual(got?.loginCustomerId, "1000000001");
    assert.strictEqual(got?.tokenSource, "agency-credential-files");
    await assert.rejects(repo.upsertTenant({
      tenantId: "agency", loginCustomerId: "506-460-8574",
      scopes: "s", tokenSource: "x",
    }), /digits/i);
  } finally { db.close(); }
});

test("tenant repo: replaceClients is authoritative per run, ordered listing", async () => {
  const db = memDb();
  try {
    const repo = new TenantRepository(db);
    await repo.replaceClients("agency", [
      { customerId: "222", resourceName: "customers/222" },
      { customerId: "111", resourceName: "customers/111" },
    ]);
    assert.deepStrictEqual((await repo.listClients("agency")).map((c) => c.customerId), ["111", "222"]);
    await repo.replaceClients("agency", [{ customerId: "333", resourceName: "customers/333" }]);
    assert.deepStrictEqual((await repo.listClients("agency")).map((c) => c.customerId), ["333"]);
  } finally { db.close(); }
});
