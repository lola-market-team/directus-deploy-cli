import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { splitSql } from "../sql.js";

// Apply migrations/*.sql files idempotently. Every file gets re-applied on
// every run — that's fine because the repo convention is that migrations are
// written idempotently (CREATE TABLE IF NOT EXISTS, CREATE UNIQUE INDEX IF
// NOT EXISTS, guarded ALTER TABLE, INSERT ... ON CONFLICT DO NOTHING).
//
// Uses Directus's /raw-query/execute endpoint. A missing endpoint yields a
// clean skip rather than N confusing errors.

export interface MigrationReconcileInput {
  migrationsDir: string;
  client: DirectusClient;
  opts: ApplyOptions;
}

interface RawQueryResult {
  success: boolean;
  results?: Array<{ success: boolean; error?: string; data?: unknown[]; query?: string }>;
}

async function rawQuery(client: DirectusClient, sql: string): Promise<RawQueryResult | null> {
  try {
    const r = (await client.postRaw("/raw-query/execute", { query: sql })) as unknown;
    if (r === null || typeof r !== "object") return null;
    return r as RawQueryResult;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(" 404 ")) return null;
    throw e;
  }
}

function stripLeadingComments(s: string): string {
  let i = 0;
  while (true) {
    while (i < s.length && /\s/.test(s[i]!)) i += 1;
    if (s[i] === "-" && s[i + 1] === "-") {
      const nl = s.indexOf("\n", i);
      if (nl === -1) return "";
      i = nl + 1;
      continue;
    }
    if (s[i] === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i);
      if (end === -1) return "";
      i = end + 2;
      continue;
    }
    break;
  }
  return s.slice(i);
}

export async function reconcileMigrations(
  input: MigrationReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];

  const probe = await rawQuery(input.client, "SELECT 1 AS ok");
  if (probe === null) {
    results.push({
      kind: "migrations",
      label: "migrations",
      action: "skipped",
      reason: "/raw-query/execute not available on this target",
    });
    return results;
  }

  let entries: string[];
  try {
    entries = await readdir(input.migrationsDir);
  } catch {
    return results;
  }
  const files = entries.filter((f) => extname(f) === ".sql" && !f.startsWith("_")).sort();
  if (files.length === 0) return results;

  for (const filename of files) {
    const label = `migrations/${filename}`;
    const full = join(input.migrationsDir, filename);
    let raw: string;
    try {
      raw = await readFile(full, "utf8");
    } catch (e) {
      results.push({ kind: "migrations", label, action: "failed", reason: (e as Error).message });
      continue;
    }
    const statements = splitSql(raw).filter((s) => {
      const stripped = stripLeadingComments(s.trim()).trim();
      return stripped.length > 0 && stripped !== ";";
    });
    if (statements.length === 0) {
      results.push({ kind: "migrations", label, action: "skipped", reason: "no executable statements" });
      continue;
    }

    if (input.opts.dryRun) {
      results.push({
        kind: "migrations",
        label,
        action: "created",
        reason: `${statements.length} statement(s) would apply`,
      });
      continue;
    }

    let failedReason: string | null = null;
    for (const stmt of statements) {
      const r = await rawQuery(input.client, stmt);
      const inner = r?.results?.[0];
      if (!r?.success || !inner?.success) {
        failedReason = inner?.error ?? "unknown error";
        break;
      }
    }

    if (failedReason) {
      results.push({ kind: "migrations", label, action: "failed", reason: failedReason });
      continue;
    }
    results.push({ kind: "migrations", label, action: "created" });
  }
  return results;
}
