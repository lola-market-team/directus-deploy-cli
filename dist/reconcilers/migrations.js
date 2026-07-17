import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, extname } from "node:path";
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
async function rawQuery(client, sql) {
    try {
        const r = (await client.postRaw("/raw-query/execute", { query: sql }));
        if (r === null || typeof r !== "object")
            return null;
        return r;
    }
    catch (e) {
        const msg = e.message;
        if (msg.includes(" 404 "))
            return null;
        throw e;
    }
}
function stripLeadingComments(s) {
    let i = 0;
    while (true) {
        while (i < s.length && /\s/.test(s[i]))
            i += 1;
        if (s[i] === "-" && s[i + 1] === "-") {
            const nl = s.indexOf("\n", i);
            if (nl === -1)
                return "";
            i = nl + 1;
            continue;
        }
        if (s[i] === "/" && s[i + 1] === "*") {
            const end = s.indexOf("*/", i);
            if (end === -1)
                return "";
            i = end + 2;
            continue;
        }
        break;
    }
    return s.slice(i);
}
function sha256(s) {
    return createHash("sha256").update(s).digest("hex");
}
async function ensureTracker(client) {
    const r = await rawQuery(client, CREATE_TRACKER);
    return !!r?.success && !!r?.results?.[0]?.success;
}
async function fetchTracker(client) {
    const r = await rawQuery(client, `SELECT filename, sha256 FROM ${TRACKER_TABLE}`);
    if (r === null)
        return null;
    if (!r.success)
        return null;
    const first = r.results?.[0];
    if (!first?.success)
        return null;
    const map = new Map();
    for (const row of first.data ?? []) {
        if (row && typeof row === "object" && "filename" in row && "sha256" in row) {
            const rr = row;
            map.set(String(rr.filename), String(rr.sha256));
        }
    }
    return map;
}
function sqlLiteral(s) {
    return `'${s.replace(/'/g, "''")}'`;
}
async function insertTrackerRow(client, filename, hash) {
    const r = await rawQuery(client, `INSERT INTO ${TRACKER_TABLE} (filename, sha256) VALUES (${sqlLiteral(filename)}, ${sqlLiteral(hash)}) ON CONFLICT (filename) DO NOTHING`);
    const inner = r?.results?.[0];
    if (!r?.success || !inner?.success) {
        return { ok: false, reason: inner?.error ?? "tracker insert failed" };
    }
    return { ok: true };
}
async function readSqlDir(dir, keyPrefix) {
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return [];
    }
    const names = entries.filter((f) => extname(f) === ".sql" && !f.startsWith("_")).sort();
    const out = [];
    for (const filename of names) {
        const path = join(dir, filename);
        const raw = await readFile(path, "utf8");
        out.push({
            key: keyPrefix ? `${keyPrefix}${filename}` : filename,
            filename,
            path,
            raw,
            hash: sha256(raw),
        });
    }
    return out;
}
async function readAllMigrations(input) {
    const root = await readSqlDir(input.migrationsDir, "");
    if (!input.includeExtensions)
        return root;
    const extensionsDir = input.extensionsDir ?? "./extensions";
    let extNames;
    try {
        extNames = (await readdir(extensionsDir, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
    }
    catch {
        return root;
    }
    const extFiles = [];
    for (const name of extNames) {
        const dir = join(extensionsDir, name, "migrations");
        const files = await readSqlDir(dir, `ext/${name}/`);
        extFiles.push(...files);
    }
    return [...root, ...extFiles];
}
export async function reconcileMigrations(input) {
    const results = [];
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
    if (files.length === 0)
        return results;
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
    const tracker = (await fetchTracker(input.client)) ?? new Map();
    for (const file of files) {
        const label = `migrations/${file.key}`;
        const recordedHash = tracker.get(file.key);
        // UNCHANGED — already applied at this hash.
        if (recordedHash === file.hash) {
            results.push({ kind: "migrations", label, action: "unchanged" });
            continue;
        }
        // MUTATED — recorded under a different hash. Never rewrite silently.
        if (recordedHash !== undefined && recordedHash !== file.hash) {
            results.push({
                kind: "migrations",
                label,
                action: "failed",
                reason: `content mismatch: tracker recorded sha256 ${recordedHash.slice(0, 12)}…, file now hashes to ${file.hash.slice(0, 12)}…. Migrations are immutable — add a new migration instead.`,
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
        let failedReason = null;
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
export async function adoptMigrations(input) {
    const results = [];
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
    if (files.length === 0)
        return results;
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
    const tracker = (await fetchTracker(input.client)) ?? new Map();
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
//# sourceMappingURL=migrations.js.map