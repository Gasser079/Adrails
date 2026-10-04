import test from "node:test";
import assert from "node:assert";
import { parseGaql, validateGaql, type FieldsSnapshot } from "../gaql.js";

// Minimal inline fixture (no network, no snapshot file).
const SNAP: FieldsSnapshot = {
  version: "test",
  fields: [
    { name: "campaign", category: "RESOURCE", dataType: null, selectable: true, selectableWith: null },
    { name: "campaign.id", category: "ATTRIBUTE", dataType: "INT64", selectable: true, selectableWith: null },
    { name: "campaign.name", category: "ATTRIBUTE", dataType: "STRING", selectable: true, selectableWith: null },
    { name: "metrics.conversions", category: "METRIC", dataType: "INT64", selectable: true, selectableWith: null },
    { name: "segments.date", category: "SEGMENT", dataType: "DATE", selectable: true, selectableWith: ["campaign", "ad_group"] },
    { name: "ad_group.id", category: "ATTRIBUTE", dataType: "INT64", selectable: true, selectableWith: null },
    { name: "change_event", category: "RESOURCE", dataType: null, selectable: true, selectableWith: null },
    { name: "change_event.change_date_time", category: "ATTRIBUTE", dataType: "DATE", selectable: true, selectableWith: null },
    { name: "dead.field", category: "ATTRIBUTE", dataType: "STRING", selectable: false, selectableWith: null },
  ],
  resourceDetails: {
    campaign: { segments: ["segments.date"], metrics: ["metrics.conversions"] },
    change_event: { segments: [], metrics: [] },
  },
};

test("gaql: valid query passes clean", () => {
  assert.deepStrictEqual(
    validateGaql("SELECT campaign.name, metrics.conversions, segments.date FROM campaign WHERE segments.date >= '2026-01-01'", SNAP),
    [],
  );
});

test("gaql: typo field fails", () => {
  const issues = validateGaql("SELECT campaign.naem FROM campaign", SNAP);
  assert.ok(issues.some((i) => i.includes("unknown field 'campaign.naem'")), JSON.stringify(issues));
});

test("gaql: wrong-resource metric fails", () => {
  const issues = validateGaql("SELECT metrics.conversions FROM change_event WHERE change_event.change_date_time > '2026-01-01' LIMIT 10", SNAP);
  assert.ok(issues.some((i) => i.includes("not selectable with FROM 'change_event'")), JSON.stringify(issues));
});

test("gaql: unknown FROM resource fails", () => {
  const issues = validateGaql("SELECT campaign.name FROM camapign", SNAP);
  assert.ok(issues.some((i) => i.includes("unknown FROM resource")), JSON.stringify(issues));
});

test("gaql: change_event domain rules enforced", () => {
  const noLimit = validateGaql("SELECT change_event.change_date_time FROM change_event WHERE change_event.change_date_time > '2026-01-01'", SNAP);
  assert.ok(noLimit.some((i) => i.includes("LIMIT")), JSON.stringify(noLimit));
  const noDate = validateGaql("SELECT change_event.change_date_time FROM change_event LIMIT 10", SNAP);
  assert.ok(noDate.some((i) => i.includes("change_date_time filter")), JSON.stringify(noDate));
  const withMetrics = validateGaql("SELECT metrics.conversions FROM change_event WHERE change_event.change_date_time > '2026-01-01' LIMIT 10", SNAP);
  assert.ok(withMetrics.some((i) => i.includes("does not support metrics")), JSON.stringify(withMetrics));
});

test("gaql: non-selectable field fails", () => {
  const issues = validateGaql("SELECT dead.field FROM campaign", SNAP);
  assert.ok(issues.some((i) => i.includes("not selectable")), JSON.stringify(issues));
});
