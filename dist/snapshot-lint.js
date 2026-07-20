import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return null;
    }
}
async function listJson(dir) {
    try {
        const entries = await readdir(dir);
        return entries.filter((f) => f.endsWith(".json")).sort();
    }
    catch {
        return [];
    }
}
async function listSubdirs(dir) {
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
    }
    catch {
        return [];
    }
}
function rel(root, path) {
    return root ? relative(root, path) : path;
}
async function loadKnownCollections(collectionsDir) {
    const names = new Set();
    const bySchema = new Map();
    const bySchemaOnly = new Set();
    for (const f of await listJson(collectionsDir)) {
        const path = join(collectionsDir, f);
        const data = await readJson(path);
        if (!data)
            continue;
        const c = String(data.collection ?? "");
        if (c) {
            names.add(c);
            bySchema.set(c, path);
            if (data.schema)
                bySchemaOnly.add(c);
        }
    }
    return { names, bySchema, bySchemaOnly };
}
async function checkGroupRefs(collectionsDir, known, root) {
    const offenders = [];
    for (const f of await listJson(collectionsDir)) {
        const path = join(collectionsDir, f);
        const data = await readJson(path);
        if (!data)
            continue;
        const meta = data.meta;
        const group = meta ? String(meta.group ?? "") : "";
        if (group && !known.has(group)) {
            offenders.push({
                file: rel(root, path),
                message: `meta.group="${group}" — no such collection in snapshot`,
            });
        }
    }
    return offenders;
}
async function checkFieldFks(fieldsDir, known, root) {
    const offenders = [];
    for (const coll of await listSubdirs(fieldsDir)) {
        const collDir = join(fieldsDir, coll);
        for (const f of await listJson(collDir)) {
            const path = join(collDir, f);
            const data = await readJson(path);
            if (!data)
                continue;
            const schema = data.schema;
            const fkTable = schema ? String(schema.foreign_key_table ?? "") : "";
            if (!fkTable)
                continue;
            // Directus system collections (directus_users, directus_files, …) are
            // runtime-provided; they never appear in the snapshot.
            if (fkTable.startsWith("directus_"))
                continue;
            if (!known.has(fkTable)) {
                offenders.push({
                    file: rel(root, path),
                    message: `FK → ${fkTable} — no such collection in snapshot`,
                });
            }
        }
    }
    return offenders;
}
async function checkDataCollectionsHaveFields(bySchema, bySchemaOnly, fieldsDir, root) {
    const offenders = [];
    for (const name of bySchemaOnly) {
        const collPath = bySchema.get(name);
        if (!collPath)
            continue;
        const collFieldsDir = join(fieldsDir, name);
        let hasField = false;
        if (existsSync(collFieldsDir)) {
            const files = await listJson(collFieldsDir);
            hasField = files.length > 0;
        }
        if (!hasField) {
            offenders.push({
                file: rel(root, collPath),
                message: `collection '${name}' has a schema block but no snapshot/fields/${name}/ dir — pull the schema (directus-deploy snapshot pull, or scripts/pull-collection-schema.py)`,
            });
        }
    }
    return offenders;
}
async function checkRegisterManifestPairing(registerDir, known, fieldsDir, root) {
    const offenders = [];
    for (const f of await listJson(registerDir)) {
        const path = join(registerDir, f);
        const data = await readJson(path);
        if (!data) {
            offenders.push({ file: rel(root, path), message: "unreadable" });
            continue;
        }
        const table = String(data.table ?? "");
        if (!table) {
            offenders.push({ file: rel(root, path), message: "missing 'table' key" });
            continue;
        }
        if (!known.has(table)) {
            offenders.push({
                file: rel(root, path),
                message: `register manifest for '${table}' but no snapshot/collections/${table}.json`,
            });
            continue;
        }
        const collFieldsDir = join(fieldsDir, table);
        let hasField = false;
        if (existsSync(collFieldsDir)) {
            const files = await listJson(collFieldsDir);
            hasField = files.length > 0;
        }
        if (!hasField) {
            offenders.push({
                file: rel(root, path),
                message: `register manifest for '${table}' but snapshot/fields/${table}/ is empty or missing`,
            });
        }
    }
    return offenders;
}
// Every directory that can hold migrations: the repo-root migrations/ AND
// each extensions/<name>/migrations/. Both feed the same tracker (extension
// files under `ext/<name>/<file>` keys) and both are applied by the same
// reconciler, so a hazard in one is a hazard in the other.
//
// This check used to scan only the root dir. The gap was not theoretical: a
// `;` inside a `--` comment in extensions/rental-fsm/migrations/074 reached a
// live target, where the server-side splitter chopped the file mid-statement
// and the DROP CONSTRAINT never ran — while the apply reported success and the
// schema was silently unchanged.
async function migrationDirs(migrationsDir) {
    const dirs = [migrationsDir];
    // migrationsDir is <repo>/migrations, so extensions/ is its sibling.
    const extensionsRoot = join(dirname(migrationsDir), "extensions");
    const entries = await readdir(extensionsRoot, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
        if (!e.isDirectory())
            continue;
        const candidate = join(extensionsRoot, e.name, "migrations");
        const stat = await readdir(candidate).catch(() => null);
        if (stat)
            dirs.push(candidate);
    }
    return dirs;
}
async function checkMigrationCommentSemicolons(migrationsDir, root) {
    const offenders = [];
    const commentRe = /^\s*--.*;/;
    for (const dir of await migrationDirs(migrationsDir)) {
        const sqlFiles = (await readdir(dir).catch(() => []))
            .filter((f) => f.endsWith(".sql"))
            .sort();
        for (const f of sqlFiles) {
            const path = join(dir, f);
            let raw;
            try {
                raw = await readFile(path, "utf8");
            }
            catch {
                continue;
            }
            const lines = raw.split("\n");
            for (let i = 0; i < lines.length; i++) {
                if (commentRe.test(lines[i])) {
                    offenders.push({
                        file: `${rel(root, path)}:${i + 1}`,
                        message: "'--' line contains ';' — raw-query's naive splitter will chop the file here",
                    });
                }
            }
        }
    }
    return offenders;
}
export async function lintSnapshot(input) {
    const collectionsDir = join(input.snapshotDir, "collections");
    const fieldsDir = join(input.snapshotDir, "fields");
    const root = input.repoRoot;
    if (!existsSync(collectionsDir)) {
        return {
            collectionsScanned: 0,
            offenders: [
                { file: collectionsDir, message: "snapshot/collections not found" },
            ],
        };
    }
    const { names, bySchema, bySchemaOnly } = await loadKnownCollections(collectionsDir);
    const offenders = [
        ...(await checkGroupRefs(collectionsDir, names, root)),
        ...(await checkFieldFks(fieldsDir, names, root)),
        ...(await checkMigrationCommentSemicolons(input.migrationsDir, root)),
        ...(await checkRegisterManifestPairing(input.registerDir, names, fieldsDir, root)),
        ...(await checkDataCollectionsHaveFields(bySchema, bySchemaOnly, fieldsDir, root)),
    ];
    return { collectionsScanned: names.size, offenders };
}
//# sourceMappingURL=snapshot-lint.js.map