// @adrails/ads-client/gaql — CI-time GAQL compatibility check.
// Validates static scan queries against the committed googleAdsFields snapshot
// (same source the Query Builder uses). Invalid queries fail the build, not
// the 3 AM cron. Dynamic user-supplied queries are NOT validated here — they
// fail at the Google boundary with classified errors instead.
export interface FieldArtifact {
  name: string;
  category: string | null;
  dataType: string | null;
  selectable: boolean | null;
  selectableWith: string[] | null;
}

export interface ResourceDetail {
  segments: string[];
  metrics: string[];
  missing?: boolean;
}

export interface FieldsSnapshot {
  version: string;
  fields: FieldArtifact[];
  resourceDetails: Record<string, ResourceDetail>;
}

export interface ParsedGaql {
  select: string[];
  from: string;
  where: string;
  limit: number | null;
}

/** Split a SELECT list on top-level commas (parens-aware; GAQL has no strings with commas here). */
export function parseGaql(query: string): ParsedGaql {
  const norm = query.replace(/\s+/g, " ").trim();
  const m = /^SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][\w]*)\s*(WHERE\s+(.+?))?\s*(ORDER BY\s+.+?)?\s*(LIMIT\s+(\d+))?\s*$/i.exec(norm);
  if (!m) throw new Error(`gaql_unparseable: ${query.slice(0, 120)}`);
  const [, selectRaw, from, , where, , , limitRaw] = m;
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of selectRaw) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return { select: parts, from, where: (where ?? "").trim(), limit: limitRaw ? Number(limitRaw) : null };
}

/**
 * Returns a list of issues; empty means valid. Rules:
 *  1. FROM resource must exist in the snapshot.
 *  2. Every SELECT field must exist and be selectable.
 *  3. Compatibility with FROM: own attributes OK; METRIC must be in the
 *     resource's metrics[]; SEGMENT in segments[] (or selectableWith).
 *     Other attributes must name the FROM resource or list it in selectableWith.
 *  4. change_event domain rules: LIMIT <= 10000 required, change_date_time
 *     filter required, no metrics.* selected.
 */
export function validateGaql(query: string, snap: FieldsSnapshot): string[] {
  const issues: string[] = [];
  let parsed: ParsedGaql;
  try {
    parsed = parseGaql(query);
  } catch (err) {
    return [`unparseable query (simplify or extend the parser): ${String((err as Error)?.message ?? err)}`];
  }
  const detail = snap.resourceDetails[parsed.from];
  if (!detail || detail.missing) {
    return [`unknown FROM resource '${parsed.from}'`];
  }
  const byName = new Map(snap.fields.map((f) => [f.name, f]));
  for (const sel of parsed.select) {
    const field = byName.get(sel);
    if (!field) {
      issues.push(`unknown field '${sel}'`);
      continue;
    }
    if (field.selectable === false) {
      issues.push(`field '${sel}' is not selectable`);
      continue;
    }
    const prefix = sel.includes(".") ? sel.slice(0, sel.indexOf(".")) : "";
    if (field.category === "METRIC") {
      if (!detail.metrics.includes(sel)) issues.push(`metric '${sel}' not selectable with FROM '${parsed.from}'`);
    } else if (field.category === "SEGMENT") {
      const ok = detail.segments.includes(sel) || (field.selectableWith ?? []).includes(parsed.from);
      if (!ok) issues.push(`segment '${sel}' not selectable with FROM '${parsed.from}'`);
    } else if (prefix && prefix !== parsed.from && !(field.selectableWith ?? []).includes(parsed.from)) {
      issues.push(`attribute '${sel}' not compatible with FROM '${parsed.from}'`);
    }
  }
  if (parsed.from === "change_event") {
    if (parsed.limit === null || parsed.limit > 10000) {
      issues.push("change_event requires LIMIT <= 10000");
    }
    if (!/change_event\.change_date_time/i.test(parsed.where)) {
      issues.push("change_event requires a change_date_time filter");
    }
    if (parsed.select.some((s) => s.startsWith("metrics."))) {
      issues.push("change_event does not support metrics.* selection");
    }
  }
  return issues;
}
