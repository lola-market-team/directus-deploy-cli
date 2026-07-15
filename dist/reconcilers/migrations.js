import { readdir, readFile } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import { splitSql } from "../sql.js";
// Apply migrations/*.sql files idempotently. Tracks applied set in a
// `lola_deploy_migrations` table on the target so we don't re-run history on
// every deploy (the backend's convention is that migrations are idempotent
// via `IF NOT EXISTS`, so re-running is safe, but pointless and slow).
//
// Uses Directus's /raw-query/execute endpoint — the same one the backend has
// used for years. Not Postgres-agnostic, but nothing else in this repo is
// either (we're a Directus deploy tool). Callers on a fresh env need the
// endpoint deployed as an extension; we detect the 404 and skip cleanly.
//
// Requires: /raw-query/execute deployed on the target. We PROBE it first so a
// missing extension yields a clean skip rather than N confusing errors.
const TRACKER_TABLE = "lola_deploy_migrations";
const CREATE_TRACKER = `
  CREATE TABLE IF NOT EXISTS ${TRACKER_TABLE} (
    filename TEXT PRIMARY KEY,
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
        // 404 = extension not installed
        const msg = e.message;
        if (msg.includes(" 404 "))
            return null;
        throw e;
    }
}
async function fetchAppliedFilenames(client) {
    const r = await rawQuery(client, `SELECT filename FROM ${TRACKER_TABLE}`);
    if (r === null)
        return null;
    if (!r.success)
        return null;
    const first = r.results?.[0];
    if (!first?.success)
        return null;
    const rows = first.data ?? [];
    const set = new Set();
    for (const row of rows) {
        if (row && typeof row === "object" && "filename" in row) {
            set.add(String(row.filename));
        }
    }
    return set;
}
export async function reconcileMigrations(input) {
    const results = [];
    // Probe for the endpoint. Failing here is not an error — a fresh env just
    // hasn't installed the raw-query extension yet.
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
    let entries;
    try {
        entries = await readdir(input.migrationsDir);
    }
    catch {
        return results; // no migrations dir → nothing to apply
    }
    const files = entries.filter((f) => extname(f) === ".sql" && !f.startsWith("_")).sort();
    if (files.length === 0)
        return results;
    // Ensure the tracker exists (idempotent).
    if (!input.opts.dryRun) {
        const created = await rawQuery(input.client, CREATE_TRACKER);
        if (!created?.success) {
            results.push({
                kind: "migrations",
                label: `migrations/${TRACKER_TABLE}`,
                action: "failed",
                reason: "could not create tracker table",
            });
            return results;
        }
    }
    const applied = (await fetchAppliedFilenames(input.client)) ?? new Set();
    for (const filename of files) {
        const label = `migrations/${filename}`;
        if (applied.has(filename)) {
            results.push({ kind: "migrations", label, action: "unchanged" });
            continue;
        }
        const full = join(input.migrationsDir, filename);
        let raw;
        try {
            raw = await readFile(full, "utf8");
        }
        catch (e) {
            results.push({ kind: "migrations", label, action: "failed", reason: e.message });
            continue;
        }
        // Filter out statements that are purely comments/whitespace after their
        // leading `--` or `/* ... */` blocks. Anything else (including statements
        // that BEGIN with a comment but have real SQL after) stays.
        const stripLeadingComments = (s) => {
            let i = 0;
            // repeat until no comments remain at the head
            // eslint-disable-next-line no-constant-condition
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
        };
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
        // Apply. If any statement fails, report and stop (don't record as applied).
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
        const recorded = await rawQuery(input.client, `INSERT INTO ${TRACKER_TABLE} (filename) VALUES ('${basename(filename).replace(/'/g, "''")}')`);
        if (!recorded?.success) {
            results.push({
                kind: "migrations",
                label,
                action: "failed",
                reason: "applied statements but could not record in tracker",
            });
            continue;
        }
        results.push({ kind: "migrations", label, action: "created" });
    }
    return results;
}
//# sourceMappingURL=migrations.js.map