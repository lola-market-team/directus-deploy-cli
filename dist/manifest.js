// Load the snapshot files that describe the desired state. Reads the same
// on-disk shape directus-sync-style repo uses under directus_config/, so we
// can drop this tool into the existing repo without a migration.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
async function readJsonDir(dir) {
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return [];
    }
    const files = entries.filter((f) => f.endsWith(".json")).sort();
    const out = [];
    for (const f of files) {
        const text = await readFile(join(dir, f), "utf8");
        out.push(JSON.parse(text));
    }
    return out;
}
async function readCollectionSubdirs(dir) {
    const map = new Map();
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: false });
    }
    catch {
        return map;
    }
    for (const name of entries.sort()) {
        const rows = await readJsonDir(join(dir, name));
        if (rows.length)
            map.set(name, rows);
    }
    return map;
}
async function readJsonArray(path) {
    try {
        const text = await readFile(path, "utf8");
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
export async function readRegisterManifests(dir) {
    const set = new Set();
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return set;
    }
    for (const f of entries) {
        if (!f.endsWith(".json"))
            continue;
        try {
            const j = JSON.parse(await readFile(join(dir, f), "utf8"));
            if (j.table)
                set.add(j.table);
        }
        catch {
            // Ignore malformed manifests here — the caller reports them separately.
        }
    }
    return set;
}
export async function loadSnapshot(paths) {
    return {
        collections: await readJsonDir(join(paths.snapshotDir, "collections")),
        fieldsByCollection: await readCollectionSubdirs(join(paths.snapshotDir, "fields")),
        relationsByCollection: await readCollectionSubdirs(join(paths.snapshotDir, "relations")),
        policies: await readJsonArray(join(paths.configDir, "policies.json")),
        roles: await readJsonArray(join(paths.configDir, "roles.json")),
        permissions: await readJsonArray(join(paths.configDir, "permissions.json")),
        flows: await readJsonArray(join(paths.configDir, "flows.json")),
        operations: await readJsonArray(join(paths.configDir, "operations.json")),
        registerManifests: await readRegisterManifests(paths.registerDir),
    };
}
//# sourceMappingURL=manifest.js.map