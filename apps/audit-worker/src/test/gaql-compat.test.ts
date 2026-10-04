import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateGaql, type FieldsSnapshot } from "@adrails/ads-client";
import { ALL_BUILDERS } from "../queries.js";

// Every static scan query must validate clean against the committed v25
// snapshot. If this test fails, the query is wrong — fix the builder, not the test.
function loadSnapshot(): FieldsSnapshot {
  const p = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..", "..", "..", "..",
    "packages", "ads-client", "fields", "v25-fields.json",
  );
  return JSON.parse(fs.readFileSync(p, "utf8")) as FieldsSnapshot;
}

test("gaql-compat: all six scan builders validate against the v25 snapshot", () => {
  const snap = loadSnapshot();
  assert.ok(snap.fields.length > 500, `snapshot looks thin (${snap.fields.length} fields)`);
  for (const { name, build } of ALL_BUILDERS) {
    const issues = validateGaql(build(), snap);
    assert.deepStrictEqual(issues, [], `${name}: ${issues.join(" | ")}`);
  }
});
