import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
async function listJson(dir) {
    try {
        return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    }
    catch {
        return [];
    }
}
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return null;
    }
}
// Sniff the same drift condition the linter surfaces.
async function detectDrift(snapshotDir) {
    const collectionsDir = join(snapshotDir, "collections");
    const fieldsDir = join(snapshotDir, "fields");
    const drift = [];
    for (const f of await listJson(collectionsDir)) {
        const data = await readJson(join(collectionsDir, f));
        if (!data)
            continue;
        if (!data.schema)
            continue; // UI folder / group, no fields expected
        const name = String(data.collection ?? "");
        if (!name)
            continue;
        const collFieldsDir = join(fieldsDir, name);
        let hasField = false;
        if (existsSync(collFieldsDir)) {
            const files = await listJson(collFieldsDir);
            hasField = files.length > 0;
        }
        if (!hasField)
            drift.push(name);
    }
    return drift.sort();
}
async function writeJsonFile(path, data) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    await mkdir(parent, { recursive: true });
    // Snapshot files are content-only — strip server-side numeric ids.
    const copy = { ...data };
    delete copy.id;
    const meta = copy.meta;
    if (meta && "id" in meta) {
        const m = { ...meta };
        delete m.id;
        copy.meta = m;
    }
    await writeFile(path, JSON.stringify(copy, null, 2) + "\n", "utf8");
}
function getStatus(e) {
    if (e && typeof e === "object" && "status" in e) {
        const s = e.status;
        return typeof s === "number" ? s : null;
    }
    // Fallback: parse the tool's error message shape "<status> <url> :: <body>".
    if (e instanceof Error) {
        const m = e.message.match(/^(\d{3})\s/);
        if (m)
            return parseInt(m[1], 10);
    }
    return null;
}
async function pullOne(input, name) {
    const fieldsDir = join(input.snapshotDir, "fields", name);
    const relationsDir = join(input.snapshotDir, "relations", name);
    let fields;
    try {
        fields = await input.client.get(`/fields/${name}`);
    }
    catch (e) {
        const status = getStatus(e);
        if (status === 403 || status === 404) {
            // Phantom collection — drop the snapshot file.
            const collPath = join(input.snapshotDir, "collections", `${name}.json`);
            let droppedPath;
            if (existsSync(collPath)) {
                if (!input.dryRun)
                    await rm(collPath);
                droppedPath = collPath;
            }
            return { collection: name, action: "phantom", droppedPath };
        }
        return { collection: name, action: "failed", error: e.message };
    }
    const fieldRows = Array.isArray(fields) ? fields : [];
    let written = 0;
    let skipped = 0;
    for (const f of fieldRows) {
        // Directus /fields/<name> returns every Postgres column, including
        // adopted-but-unregistered raw-SQL columns (meta:null, type:"unknown").
        // Writing those to snapshot makes apply try to re-CREATE the column
        // and 400 with "Field already exists". Skip them here — use a
        // register manifest to promote them.
        const meta = f.meta;
        const type = String(f.type ?? "");
        if (meta === null || meta === undefined || type === "unknown") {
            skipped += 1;
            continue;
        }
        if (!input.dryRun) {
            const field = String(f.field ?? "");
            if (field)
                await writeJsonFile(join(fieldsDir, `${field}.json`), f);
        }
        written += 1;
    }
    let rels;
    try {
        rels = await input.client.get(`/relations/${name}`);
    }
    catch {
        rels = [];
    }
    const relRows = Array.isArray(rels) ? rels : [];
    let relsWritten = 0;
    for (const r of relRows) {
        if (!input.dryRun) {
            const field = String(r.field ?? "");
            if (field)
                await writeJsonFile(join(relationsDir, `${field}.json`), r);
        }
        relsWritten += 1;
    }
    return {
        collection: name,
        action: input.dryRun ? "dry-run" : "pulled",
        fieldsWritten: written,
        relationsWritten: relsWritten,
        fieldsSkipped: skipped,
    };
}
export async function pullSnapshot(input) {
    const targets = input.targets?.length ? input.targets : await detectDrift(input.snapshotDir);
    const out = [];
    for (const t of targets) {
        out.push(await pullOne(input, t));
    }
    return out;
}
//# sourceMappingURL=snapshot-pull.js.map