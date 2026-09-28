// @adrails/ai-middleware/schema-guard — deterministic validation barrier.
// Every LLM output that can become an action/answer is validated HERE.
// Invalid => bounded re-prompt cycle (maxReprompts, default 2) with the exact
// structural error appended. Exhaustion throws — never returns unvalidated data.
import type { z } from "zod";

export interface GuardFailure {
  issues: string[];
  attempts: number;
  raw: string;
}

export class SchemaGuardError extends Error {
  readonly issues: string[];
  readonly attempts: number;
  readonly raw: string;
  constructor(f: GuardFailure) {
    super(`schema_guard_failed after ${f.attempts} attempts: ${f.issues.join(" | ").slice(0, 400)}`);
    this.name = "SchemaGuardError";
    this.issues = f.issues;
    this.attempts = f.attempts;
    this.raw = f.raw;
  }
}

function issueList(err: unknown): string[] {
  const e = err as { issues?: Array<{ path?: Array<string | number>; message?: string }> };
  if (e?.issues && Array.isArray(e.issues)) {
    return e.issues.map((i) => `${(i.path ?? []).join(".") || "(root)"}: ${i.message ?? "invalid"}`);
  }
  return [String((err as Error)?.message ?? err)];
}

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

export async function guard<T>(schema: z.ZodType<T>, raw: string): Promise<{ ok: true; data: T } | { ok: false; issues: string[] }> {
  try {
    const data = schema.parse(JSON.parse(extractJson(raw)));
    return { ok: true, data };
  } catch (err) {
    return { ok: false, issues: issueList(err) };
  }
}

export interface Reprompter {
  /** Generate candidate text. `hint` is undefined on the first attempt. */
  (hint: string | undefined): Promise<string>;
}

/** Validate with bounded self-healing. Returns typed data or throws SchemaGuardError. */
export async function guardWithReprompt<T>(schema: z.ZodType<T>, generate: Reprompter, maxReprompts = 2): Promise<T> {
  let hint: string | undefined;
  let attempts = 0;
  let last = "";
  for (let i = 0; i <= maxReprompts; i++) {
    attempts++;
    const raw = await generate(hint);
    last = raw;
    const res = await guard(schema, raw);
    if (res.ok) return res.data;
    hint = `Your previous output failed schema validation. Fix exactly these issues and return ONLY valid JSON:\n- ${res.issues.join("\n- ")}`;
  }
  const final = issueList(new Error("reprompt budget exhausted"));
  throw new SchemaGuardError({ issues: [hint ?? "unknown schema failure", ...final].slice(0, 5), attempts, raw: last.slice(0, 1000) });
}
