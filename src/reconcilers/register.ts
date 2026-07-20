import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";

// Register raw-SQL-created tables with Directus, idempotently. Each manifest
// at `migrations/register/<table>.json` describes a table whose columns exist
// in Postgres but haven't been picked up by Directus. This reconciler:
//
//   1. Verifies the underlying table exists (surfaces a clear failure if not).
//   2. INSERTs into directus_collections when the row is missing (adoption
//      only — POST /collections would CREATE the table).
//   3. Iterates every column that lacks a directus_fields row and PATCHes
//      one in with meta inferred from the Postgres type + manifest overrides.
//
// Idempotent: re-running after a fully-registered table is a no-op.
//
// Adopts raw-SQL tables into Directus. Uses
// /raw-query/execute (same as migrations reconciler). Skips cleanly if the
// raw-query endpoint isn't installed on the target.

interface RegisterManifest {
  table: string;
  collection_meta?: {
    hidden?: boolean;
    icon?: string;
    note?: string;
  };
  fields?: Record<string, Record<string, unknown>>;
}

export interface RegisterReconcileInput {
  registerDir: string;
  client: DirectusClient;
  opts: ApplyOptions;
}

interface RawQueryResult {
  success: boolean;
  results?: Array<{ success: boolean; error?: string; data?: unknown[] }>;
}

async function rawQuery(
  client: DirectusClient,
  sql: string,
): Promise<{ ok: boolean; data: unknown[]; error?: string }> {
  try {
    const r = (await client.postRaw("/raw-query/execute", { query: sql })) as unknown;
    if (r === null || typeof r !== "object") return { ok: false, data: [], error: "no response" };
    const res = r as RawQueryResult;
    const inner = res.results?.[0];
    if (!res.success || !inner?.success) {
      return { ok: false, data: [], error: inner?.error ?? "unknown raw-query error" };
    }
    return { ok: true, data: inner.data ?? [] };
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(" 404 ")) return { ok: false, data: [], error: "raw-query not available" };
    return { ok: false, data: [], error: msg };
  }
}

function metaFor(dataType: string, name: string): { interface: string; special: string[] | null } {
  const t = dataType.toLowerCase();
  if (t === "uuid") return { interface: "input", special: name === "id" ? ["uuid"] : null };
  if (t === "boolean") return { interface: "boolean", special: ["cast-boolean"] };
  if (t.startsWith("timestamp") || t === "date") return { interface: "datetime", special: null };
  if (["integer", "smallint", "bigint", "numeric", "real", "double precision"].includes(t)) {
    return { interface: "input", special: null };
  }
  if (t === "json" || t === "jsonb") return { interface: "input-code", special: ["cast-json"] };
  return { interface: "input", special: null };
}

function sqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function readManifests(dir: string): Promise<{ path: string; manifest: RegisterManifest }[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: { path: string; manifest: RegisterManifest }[] = [];
  for (const f of entries.sort()) {
    if (!f.endsWith(".json")) continue;
    const p = join(dir, f);
    try {
      const parsed = JSON.parse(await readFile(p, "utf8")) as RegisterManifest;
      if (parsed?.table) out.push({ path: p, manifest: parsed });
    } catch {
      // Malformed manifests get reported by reconcile below.
      out.push({ path: p, manifest: { table: "" } });
    }
  }
  return out;
}

export async function reconcileRegister(
  input: RegisterReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  const manifests = await readManifests(input.registerDir);
  if (manifests.length === 0) return results;

  // Probe raw-query — same pattern as migrations reconciler.
  const probe = await rawQuery(input.client, "SELECT 1 AS ok");
  if (!probe.ok) {
    results.push({
      kind: "migrations",
      label: "register/*",
      action: "skipped",
      reason: "raw-query endpoint not available",
    });
    return results;
  }

  for (const { path, manifest } of manifests) {
    const table = manifest.table;
    const label = `register/${table || path}`;
    if (!table || !/^[a-z0-9_]+$/.test(table)) {
      results.push({
        kind: "migrations",
        label,
        action: "failed",
        reason: `invalid or missing 'table' in ${path}`,
      });
      continue;
    }

    // Directus system collections must never go through register. Two ways
    // this reconciler would actively corrupt them:
    //   1. Adoption below INSERTs a directus_collections row when none exists.
    //      System collections are runtime-provided and have no such row, so it
    //      would fabricate a user-collection row shadowing directus_users.
    //   2. Column registration walks every column lacking a directus_fields
    //      row — for a system collection that is most of them, so it would
    //      PATCH id, email, password, role.
    // Custom columns on system collections belong in the snapshot instead
    // (directus_config/snapshot/fields/<collection>/<column>.json); the fields
    // reconciler registers them, including when the column already exists in
    // Postgres with no directus_fields row.
    if (table.startsWith("directus_")) {
      results.push({
        kind: "migrations",
        label,
        action: "failed",
        reason:
          `${table} is a Directus system collection — register manifests cannot own it. ` +
          `Declare the column as a snapshot field instead.`,
      });
      continue;
    }

    // 1. Table must exist.
    const exists = await rawQuery(
      input.client,
      `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${sqlLiteral(table)}`,
    );
    if (!exists.ok || exists.data.length === 0) {
      results.push({
        kind: "migrations",
        label,
        action: "failed",
        reason: `table '${table}' does not exist — apply its migration first`,
      });
      continue;
    }

    // 2. Adopt collection if not yet in directus_collections.
    const adopted = await rawQuery(
      input.client,
      `SELECT 1 AS ok FROM directus_collections WHERE collection = ${sqlLiteral(table)}`,
    );
    if (!adopted.ok) {
      results.push({ kind: "migrations", label, action: "failed", reason: adopted.error ?? "" });
      continue;
    }
    if (adopted.data.length === 0) {
      const cm = manifest.collection_meta ?? {};
      const hidden = cm.hidden === true;
      const iconExpr = cm.icon ? sqlLiteral(cm.icon) : "NULL";
      const noteExpr = cm.note ? sqlLiteral(cm.note) : "NULL";
      if (input.opts.dryRun) {
        results.push({
          kind: "migrations",
          label: `${label} (adopt)`,
          action: "created",
          reason: "would adopt collection",
        });
      } else {
        const inserted = await rawQuery(
          input.client,
          `INSERT INTO directus_collections (collection, hidden, singleton, icon, note)
           VALUES (${sqlLiteral(table)}, ${hidden}, false, ${iconExpr}, ${noteExpr})
           ON CONFLICT (collection) DO NOTHING`,
        );
        if (!inserted.ok) {
          results.push({ kind: "migrations", label, action: "failed", reason: inserted.error ?? "" });
          continue;
        }
        results.push({ kind: "migrations", label: `${label} (adopt)`, action: "created" });

        // The adopt is a raw INSERT (POST /collections would try to CREATE the
        // table), and a raw INSERT does not invalidate Directus's cached
        // SchemaOverview. /fields/<collection>/<field> validates against that
        // cache, so every column PATCH below then 403s with "You don't have
        // permission to access collection X or it does not exist" — even for a
        // full admin, where the operative half is "or it does not exist".
        //
        // So the reconciler creates the condition and trips over it two lines
        // later. Clear the system cache here rather than leaving the caller to
        // discover it: observed on a fresh test instance where all 7 column
        // PATCHes failed twice, then all 7 succeeded immediately after this
        // call. Best-effort — a failure here is not worth aborting the run,
        // since the column PATCHes will report their own errors.
        try {
          await input.client.post("/utils/cache/clear?system=true", {});
        } catch {
          // Non-fatal: some deployments disable the cache endpoint. If the
          // cache really was stale, the PATCHes below surface it.
        }
      }
    }

    // 3. Register unregistered columns.
    const colsRes = await rawQuery(
      input.client,
      `SELECT c.column_name, c.data_type, c.ordinal_position
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = ${sqlLiteral(table)}
          AND c.column_name NOT IN (
            SELECT field FROM directus_fields WHERE collection = ${sqlLiteral(table)}
          )
        ORDER BY c.ordinal_position`,
    );
    if (!colsRes.ok) {
      results.push({ kind: "migrations", label, action: "failed", reason: colsRes.error ?? "" });
      continue;
    }
    const cols = colsRes.data as Array<{
      column_name: string;
      data_type: string;
      ordinal_position: number;
    }>;
    if (cols.length === 0) {
      results.push({ kind: "migrations", label, action: "unchanged" });
      continue;
    }
    for (const c of cols) {
      const inferred = metaFor(c.data_type, c.column_name);
      const override = manifest.fields?.[c.column_name] ?? {};
      const meta = {
        ...inferred,
        sort: c.ordinal_position,
        width: "half",
        hidden: false,
        readonly: c.column_name === "id",
        ...override,
      };
      const perColLabel = `${label}.${c.column_name}`;
      if (input.opts.dryRun) {
        results.push({ kind: "migrations", label: perColLabel, action: "created" });
        continue;
      }
      try {
        await input.client.patch(`/fields/${table}/${c.column_name}`, { meta });
        results.push({ kind: "migrations", label: perColLabel, action: "created" });
      } catch (e) {
        results.push({
          kind: "migrations",
          label: perColLabel,
          action: "failed",
          reason: (e as Error).message,
        });
      }
    }
  }
  return results;
}
