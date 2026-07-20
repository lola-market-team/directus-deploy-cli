import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, extname } from "node:path";
import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { splitSql } from "../sql.js";

// Migration reconciler with a content-hash tracker table.
//
// Tracker shape:
//
//   CREATE TABLE _directus_deploy_migrations (
//     filename    TEXT PRIMARY KEY,
//     sha256      TEXT NOT NULL,
//     applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
//   )
//
// Per-file classification:
//
//   filename absent from tracker              → NEW      (apply, then insert)
//   filename present, hash matches            → UNCHANGED (skip execution)
//   filename present, hash differs            → MUTATED  (fail hard, don't touch DB)
//
// Bootstrap (see adoptMigrations): a fresh env whose migrations were applied
// via some prior mechanism needs a one-shot import that inserts each file's
// (name, hash) WITHOUT running the SQL. Prevents duplicate application.
//
// Uses Directus's /raw-query/execute endpoint. A missing endpoint yields a
// clean skip rather than N confusing errors.

const TRACKER_TABLE = "_directus_deploy_migrations";
const CREATE_TRACKER = `
  CREATE TABLE IF NOT EXISTS ${TRACKER_TABLE} (
    filename TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export interface MigrationReconcileInput {
  migrationsDir: string;
  client: DirectusClient;
  opts: ApplyOptions;
  // Extension-migration support: when includeExtensions is true, also scan
  // <extensionsDir>/*/migrations/*.sql and track them under keys of the form
  // "ext/<name>/<filename>". Root migrations keep bare-filename tracker keys
  // for backward compatibility.
  extensionsDir?: string;
  includeExtensions?: boolean;
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

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Immutability should constrain what a migration DOES, not its bytes.
//
// Hashing raw content means a typo fix or a corrected comment in an applied
// migration trips the content check and blocks every subsequent apply, on
// every environment — strictly worse than the mistake being fixed. It also
// makes lint findings unfixable: `snapshot lint` flags a ';' inside a '--'
// comment (raw-query's splitter has no comment awareness and chops there),
// but removing that ';' changes the hash. 96 such findings exist across 48
// already-applied migrations in one consuming repo, none of them fixable
// while the hash covers comments.
//
// So hash the executable SQL: strip line comments, drop blank lines, collapse
// runs of whitespace, and trim. Two files that differ only in commentary
// normalize to the same digest; any change to a statement still changes it.
//
// Deliberately NOT stripped: block comments. `/* ... */` can appear mid-expression
// where removing it would join tokens, and the existing splitter does not track
// them either. Line comments are safe because they always run to end-of-line.
export function normalizeSqlForHash(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      // Strip a '--' comment only when it is not inside a string literal.
      // Counting quotes is enough here: SQL escapes a quote by doubling it,
      // so a doubled quote leaves the parity unchanged.
      let inSingle = false;
      let inDouble = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === "'" && !inDouble) inSingle = !inSingle;
        else if (c === '"' && !inSingle) inDouble = !inDouble;
        else if (c === "-" && line[i + 1] === "-" && !inSingle && !inDouble) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    // Join with a space, not a newline: a statement reflowed across lines is
    // the same statement, and newlines carry no meaning in SQL outside string
    // literals (which are preserved intact above).
    .join(" ");
}

async function ensureTracker(client: DirectusClient): Promise<boolean> {
  const r = await rawQuery(client, CREATE_TRACKER);
  return !!r?.success && !!r?.results?.[0]?.success;
}

async function fetchTracker(client: DirectusClient): Promise<Map<string, string> | null> {
  const r = await rawQuery(client, `SELECT filename, sha256 FROM ${TRACKER_TABLE}`);
  if (r === null) return null;
  if (!r.success) return null;
  const first = r.results?.[0];
  if (!first?.success) return null;
  const map = new Map<string, string>();
  for (const row of first.data ?? []) {
    if (row && typeof row === "object" && "filename" in row && "sha256" in row) {
      const rr = row as { filename: unknown; sha256: unknown };
      map.set(String(rr.filename), String(rr.sha256));
    }
  }
  return map;
}

function sqlLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function insertTrackerRow(
  client: DirectusClient,
  filename: string,
  hash: string,
): Promise<{ ok: boolean; reason?: string }> {
  const r = await rawQuery(
    client,
    `INSERT INTO ${TRACKER_TABLE} (filename, sha256) VALUES (${sqlLiteral(filename)}, ${sqlLiteral(hash)}) ON CONFLICT (filename) DO NOTHING`,
  );
  const inner = r?.results?.[0];
  if (!r?.success || !inner?.success) {
    return { ok: false, reason: inner?.error ?? "tracker insert failed" };
  }
  return { ok: true };
}

interface MigrationFile {
  key: string;       // tracker PK. Root: bare filename. Extension: "ext/<name>/<filename>".
  filename: string;  // basename only, for display.
  path: string;
  raw: string;
  hash: string;        // sha256 of the normalized (comment-stripped) SQL.
  legacyHash: string;  // sha256 of raw bytes — what pre-0.17 tracker rows hold.
}

async function readSqlDir(dir: string, keyPrefix: string): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const names = entries.filter((f) => extname(f) === ".sql" && !f.startsWith("_")).sort();
  const out: MigrationFile[] = [];
  for (const filename of names) {
    const path = join(dir, filename);
    const raw = await readFile(path, "utf8");
    out.push({
      key: keyPrefix ? `${keyPrefix}${filename}` : filename,
      filename,
      path,
      raw,
      hash: sha256(normalizeSqlForHash(raw)),
      legacyHash: sha256(raw),
    });
  }
  return out;
}

async function readAllMigrations(input: MigrationReconcileInput): Promise<MigrationFile[]> {
  const root = await readSqlDir(input.migrationsDir, "");
  if (!input.includeExtensions) return root;

  const extensionsDir = input.extensionsDir ?? "./extensions";
  let extNames: string[];
  try {
    extNames = (await readdir(extensionsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return root;
  }

  const extFiles: MigrationFile[] = [];
  for (const name of extNames) {
    const dir = join(extensionsDir, name, "migrations");
    const files = await readSqlDir(dir, `ext/${name}/`);
    extFiles.push(...files);
  }
  return [...root, ...extFiles];
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

  const files = await readAllMigrations(input);
  if (files.length === 0) return results;

  // Tracker create is a schema mutation → do it only outside dry-run. In
  // dry-run, if the tracker is missing, treat everything as NEW (accurate).
  if (!input.opts.dryRun) {
    const ok = await ensureTracker(input.client);
    if (!ok) {
      results.push({
        kind: "migrations",
        label: `migrations/${TRACKER_TABLE}`,
        action: "failed",
        reason: "could not create tracker table",
      });
      return results;
    }
  }

  const tracker = (await fetchTracker(input.client)) ?? new Map<string, string>();

  for (const file of files) {
    const label = `migrations/${file.key}`;
    const recordedHash = tracker.get(file.key);

    // UNCHANGED — already applied at this hash.
    if (recordedHash === file.hash) {
      results.push({ kind: "migrations", label, action: "unchanged" });
      continue;
    }

    // Rows written before 0.17 hold a hash of the raw bytes. Accept that as a
    // match and re-baseline to the normalized digest, so the transition costs
    // nobody a false "content mismatch" on their first upgrade. Only the
    // stored hash changes; the migration is not re-run.
    if (recordedHash === file.legacyHash) {
      if (!input.opts.dryRun) {
        await rawQuery(
          input.client,
          `UPDATE ${TRACKER_TABLE} SET sha256 = ${sqlLiteral(file.hash)} WHERE filename = ${sqlLiteral(file.key)}`,
        );
      }
      results.push({
        kind: "migrations",
        label,
        action: "unchanged",
        reason: "re-baselined to comment-insensitive hash",
      });
      continue;
    }

    // MUTATED — the executable SQL differs, not just commentary. Never rewrite
    // silently. Comment-only edits no longer reach here: they normalize to the
    // recorded hash above.
    if (recordedHash !== undefined) {
      results.push({
        kind: "migrations",
        label,
        action: "failed",
        reason: `content mismatch: tracker recorded sha256 ${recordedHash.slice(0, 12)}…, file's SQL now hashes to ${file.hash.slice(0, 12)}… (comments ignored). Migrations are immutable — add a new migration instead.`,
      });
      continue;
    }

    // NEW.
    const statements = splitSql(file.raw).filter((s) => {
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

    const rec = await insertTrackerRow(input.client, file.key, file.hash);
    if (!rec.ok) {
      results.push({
        kind: "migrations",
        label,
        action: "failed",
        reason: `applied SQL but tracker insert failed: ${rec.reason}`,
      });
      continue;
    }

    results.push({ kind: "migrations", label, action: "created" });
  }
  return results;
}

// Bootstrap for envs whose migrations were applied via a prior mechanism.
// Inserts (filename, sha256) rows without executing any SQL. Idempotent:
// re-adopting is a no-op when hashes match. Fails on hash conflict, which
// tells the caller the file was edited since the target env applied it.
export async function adoptMigrations(
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

  const files = await readAllMigrations(input);
  if (files.length === 0) return results;

  if (!input.opts.dryRun) {
    const ok = await ensureTracker(input.client);
    if (!ok) {
      results.push({
        kind: "migrations",
        label: `migrations/${TRACKER_TABLE}`,
        action: "failed",
        reason: "could not create tracker table",
      });
      return results;
    }
  }

  const tracker = (await fetchTracker(input.client)) ?? new Map<string, string>();

  for (const file of files) {
    const label = `migrations/${file.key}`;
    const recordedHash = tracker.get(file.key);

    if (recordedHash === file.hash) {
      results.push({ kind: "migrations", label, action: "unchanged" });
      continue;
    }
    if (recordedHash !== undefined) {
      results.push({
        kind: "migrations",
        label,
        action: "failed",
        reason: `already adopted with sha256 ${recordedHash.slice(0, 12)}…, refusing to overwrite with ${file.hash.slice(0, 12)}…`,
      });
      continue;
    }

    if (input.opts.dryRun) {
      results.push({
        kind: "migrations",
        label,
        action: "created",
        reason: `would adopt (sha256 ${file.hash.slice(0, 12)}…)`,
      });
      continue;
    }

    const rec = await insertTrackerRow(input.client, file.key, file.hash);
    if (!rec.ok) {
      results.push({
        kind: "migrations",
        label,
        action: "failed",
        reason: rec.reason,
      });
      continue;
    }
    results.push({
      kind: "migrations",
      label,
      action: "created",
      reason: `adopted (sha256 ${file.hash.slice(0, 12)}…)`,
    });
  }
  return results;
}
