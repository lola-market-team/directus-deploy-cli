import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
async function readManifests(dir) {
    const map = new Map();
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return map;
    }
    for (const f of entries) {
        if (!f.endsWith(".json"))
            continue;
        try {
            const parsed = JSON.parse(await readFile(join(dir, f), "utf8"));
            if (parsed?.table)
                map.set(parsed.table, parsed);
        }
        catch {
            /* malformed manifest surfaces via other tooling */
        }
    }
    return map;
}
// Parse a SQL file for `CREATE TABLE (IF NOT EXISTS)? name`
// and `ALTER TABLE name ADD COLUMN (IF NOT EXISTS)? col`.
// Case-insensitive; multi-column ALTER TABLE ADD is handled by matching each
// ADD COLUMN clause independently.
function parseSql(sql) {
    const createTables = [];
    const addColumns = [];
    // Strip block + line comments to simplify matching. We keep offsets rough —
    // this is a lint, not a compiler.
    const stripped = sql
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/--[^\n]*\n/g, "\n");
    const createRe = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
    let m;
    while ((m = createRe.exec(stripped)) !== null) {
        createTables.push(m[1].toLowerCase());
    }
    // Find each `ALTER TABLE <t> …` block, then within that block find every
    // `ADD COLUMN (IF NOT EXISTS)? <c>`. Track the guard per-column so callers
    // can distinguish belt-and-suspenders (safe idiom with snapshot field) from
    // an unguarded double-write (will 500 on apply).
    const alterRe = /\bALTER\s+TABLE\s+(?:ONLY\s+)?"?([a-z_][a-z0-9_]*)"?\s*([\s\S]*?);/gi;
    while ((m = alterRe.exec(stripped)) !== null) {
        const table = m[1].toLowerCase();
        const body = m[2];
        const colRe = /\bADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
        let cm;
        while ((cm = colRe.exec(body)) !== null) {
            addColumns.push({
                table,
                column: cm[2].toLowerCase(),
                ifNotExists: !!cm[1],
            });
        }
    }
    return { createTables, addColumns };
}
async function fieldSnapshotType(snapshotDir, table, column) {
    const path = join(snapshotDir, "fields", table, `${column}.json`);
    if (!existsSync(path))
        return null;
    try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        return typeof parsed.type === "string" ? parsed.type : null;
    }
    catch {
        return null;
    }
}
function collectionSnapshotExists(snapshotDir, table) {
    return existsSync(join(snapshotDir, "collections", `${table}.json`));
}
export async function lintMigrations(input) {
    const violations = [];
    let scanned = 0;
    const manifests = await readManifests(input.registerDir);
    let files;
    try {
        files = (await readdir(input.migrationsDir))
            .filter((f) => f.endsWith(".sql") && !f.startsWith("_"))
            .sort();
    }
    catch {
        return { violations, scanned: 0 };
    }
    for (const f of files) {
        const sql = await readFile(join(input.migrationsDir, f), "utf8");
        const { createTables, addColumns } = parseSql(sql);
        scanned += 1;
        for (const table of createTables) {
            const hasManifest = manifests.has(table);
            const hasSnapshot = collectionSnapshotExists(input.snapshotDir, table);
            if (!hasManifest && !hasSnapshot) {
                violations.push({
                    kind: "table",
                    file: f,
                    table,
                    reason: `CREATE TABLE ${table} — needs migrations/register/${table}.json or directus_config/snapshot/collections/${table}.json`,
                });
            }
        }
        for (const { table, column, ifNotExists } of addColumns) {
            // Manifest match: table is listed AND either fields[column] exists or
            // fields is undefined (walk-all-unregistered mode).
            const manifest = manifests.get(table);
            const manifestCovers = !!manifest &&
                (manifest.fields === undefined ||
                    Object.prototype.hasOwnProperty.call(manifest.fields, column));
            const snapshotType = await fieldSnapshotType(input.snapshotDir, table, column);
            const snapshotCovers = !!snapshotType && snapshotType !== "unknown";
            // Double-write with a snapshot field:
            //   - Guarded (IF NOT EXISTS): legitimate belt-and-suspenders idiom.
            //     POST /fields creates the column first (config-first ordering);
            //     the migration's IF NOT EXISTS clause is a no-op. Common when a
            //     migration exists to backfill / set a default the snapshot can't
            //     express. Not a violation.
            //   - Unguarded: the reason today's digests PR failed. Whichever step
            //     runs second hits `500 column already exists`. Hard error.
            if (snapshotCovers && !ifNotExists) {
                violations.push({
                    kind: "column",
                    file: f,
                    table,
                    column,
                    reason: `${table}.${column} — unguarded ADD COLUMN conflicts with snapshot field (type=${snapshotType}). Either add IF NOT EXISTS to the ADD COLUMN (belt-and-suspenders idiom, POST /fields creates the column first), or remove the ADD COLUMN entirely (let the snapshot field be the sole writer).`,
                });
                continue;
            }
            if (snapshotCovers && ifNotExists) {
                // belt-and-suspenders idiom, safe; snapshot owns the column.
                continue;
            }
            if (manifestCovers)
                continue;
            violations.push({
                kind: "column",
                file: f,
                table,
                column,
                reason: snapshotType === "unknown"
                    ? `${table}.${column} present in snapshot with type='unknown' — add migrations/register/${table}.json`
                    : `${table}.${column} — no manifest and no snapshot field definition`,
            });
        }
    }
    return { violations, scanned };
}
//# sourceMappingURL=lint.js.map