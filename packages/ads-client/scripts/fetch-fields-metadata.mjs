// Fetch GoogleAdsField metadata for the resources our scans touch and store a
// trimmed snapshot used by CI-time GAQL validation (same source the Query
// Builder uses). Run manually on version upgrades; output is committed.
// Run: GOOGLE_ADS_CLIENT_ID=.. GOOGLE_ADS_CLIENT_SECRET=.. GOOGLE_ADS_REFRESH_TOKEN=.. \
//   node packages/ads-client/scripts/fetch-fields-metadata.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Prefixes covering every field our static scan queries select.
const PREFIXES = [
  "campaign.",
  "ad_group.",
  "ad_group_ad.",
  "change_event.",
  "recommendation.",
  "customer_client.",
  "segments.",
  "metrics.",
  "offline_conversion_upload_",
];
// Resource artifacts carry the authoritative segments[]/metrics[] lists.
const RESOURCES = [
  "campaign",
  "ad_group",
  "ad_group_ad",
  "change_event",
  "recommendation",
  "customer_client",
  "offline_conversion_upload_conversion_action_summary",
];

const { GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN } = process.env;
if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_REFRESH_TOKEN) {
  console.error("missing GOOGLE_ADS_CLIENT_ID/SECRET/REFRESH_TOKEN env");
  process.exit(1);
}

async function refresh() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: GOOGLE_ADS_CLIENT_ID,
      client_secret: GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
    }).toString(),
  });
  if (!res.ok) throw new Error(`oauth refresh failed: ${res.status}`);
  return (await res.json()).access_token;
}

const FIELDS_COLS = "name, category, data_type, selectable, selectable_with";
const RES_COLS = "name, category, selectable, segments, metrics";

async function search(token, query) {
  const out = [];
  let pageToken;
  for (;;) {
    const res = await fetch("https://googleads.googleapis.com/v25/googleAdsFields:search", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, pageSize: 1000, ...(pageToken ? { pageToken } : {}) }),
    });
    if (!res.ok) throw new Error(`fields search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    for (const r of json.results ?? []) {
      const f = r.googleAdsField ?? r;
      if (f?.name) out.push(f);
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

const token = await refresh();
const byName = new Map();
for (const p of PREFIXES) {
  const rows = await search(token, `SELECT ${FIELDS_COLS} WHERE name LIKE '${p}%'`);
  for (const f of rows) {
    if (!byName.has(f.name)) {
      byName.set(f.name, {
        name: f.name,
        category: f.category ?? null,
        dataType: f.dataType ?? null,
        selectable: f.selectable ?? null,
        selectableWith: f.selectableWith ?? null,
      });
    }
  }
  console.log(`prefix ${p}: snapshot now holds ${byName.size} artifacts`);
}
const resources = {};
for (const r of RESOURCES) {
  const rows = await search(token, `SELECT ${RES_COLS} WHERE name = '${r}'`);
  const f = rows[0];
  resources[r] = f ? { segments: f.segments ?? [], metrics: f.metrics ?? [] } : { segments: [], metrics: [], missing: true };
  console.log(`resource ${r}: segments=${resources[r].segments.length} metrics=${resources[r].metrics.length}`);
}
const out = {
  version: "v25",
  generatedAt: new Date().toISOString(),
  prefixes: PREFIXES,
  resources: RESOURCES,
  fields: [...byName.values()],
  resourceDetails: resources,
};
const outDir = path.join(here, "..", "fields");
await fs.promises.mkdir(outDir, { recursive: true });
await fs.promises.writeFile(path.join(outDir, "v25-fields.json"), JSON.stringify(out), "utf8");
console.log(`wrote ${out.fields.length} field artifacts`);
