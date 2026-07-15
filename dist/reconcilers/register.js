import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
async function rawQuery(client, sql) {
    try {
        const r = (await client.postRaw("/raw-query/execute", { query: sql }));
        if (r === null || typeof r !== "object")
            return { ok: false, data: [], error: "no response" };
        const res = r;
        const inner = res.results?.[0];
        if (!res.success || !inner?.success) {
            return { ok: false, data: [], error: inner?.error ?? "unknown raw-query error" };
        }
        return { ok: true, data: inner.data ?? [] };
    }
    catch (e) {
        const msg = e.message;
        if (msg.includes(" 404 "))
            return { ok: false, data: [], error: "raw-query not available" };
        return { ok: false, data: [], error: msg };
    }
}
function metaFor(dataType, name) {
    const t = dataType.toLowerCase();
    if (t === "uuid")
        return { interface: "input", special: name === "id" ? ["uuid"] : null };
    if (t === "boolean")
        return { interface: "boolean", special: ["cast-boolean"] };
    if (t.startsWith("timestamp") || t === "date")
        return { interface: "datetime", special: null };
    if (["integer", "smallint", "bigint", "numeric", "real", "double precision"].includes(t)) {
        return { interface: "input", special: null };
    }
    if (t === "json" || t === "jsonb")
        return { interface: "input-code", special: ["cast-json"] };
    return { interface: "input", special: null };
}
function sqlLiteral(s) {
    return `'${s.replace(/'/g, "''")}'`;
}
async function readManifests(dir) {
    let entries;
    try {
        entries = await readdir(dir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const f of entries.sort()) {
        if (!f.endsWith(".json"))
            continue;
        const p = join(dir, f);
        try {
            const parsed = JSON.parse(await readFile(p, "utf8"));
            if (parsed?.table)
                out.push({ path: p, manifest: parsed });
        }
        catch {
            // Malformed manifests get reported by reconcile below.
            out.push({ path: p, manifest: { table: "" } });
        }
    }
    return out;
}
export async function reconcileRegister(input) {
    const results = [];
    const manifests = await readManifests(input.registerDir);
    if (manifests.length === 0)
        return results;
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
        // 1. Table must exist.
        const exists = await rawQuery(input.client, `SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ${sqlLiteral(table)}`);
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
        const adopted = await rawQuery(input.client, `SELECT 1 AS ok FROM directus_collections WHERE collection = ${sqlLiteral(table)}`);
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
            }
            else {
                const inserted = await rawQuery(input.client, `INSERT INTO directus_collections (collection, hidden, singleton, icon, note)
           VALUES (${sqlLiteral(table)}, ${hidden}, false, ${iconExpr}, ${noteExpr})
           ON CONFLICT (collection) DO NOTHING`);
                if (!inserted.ok) {
                    results.push({ kind: "migrations", label, action: "failed", reason: inserted.error ?? "" });
                    continue;
                }
                results.push({ kind: "migrations", label: `${label} (adopt)`, action: "created" });
            }
        }
        // 3. Register unregistered columns.
        const colsRes = await rawQuery(input.client, `SELECT c.column_name, c.data_type, c.ordinal_position
         FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = ${sqlLiteral(table)}
          AND c.column_name NOT IN (
            SELECT field FROM directus_fields WHERE collection = ${sqlLiteral(table)}
          )
        ORDER BY c.ordinal_position`);
        if (!colsRes.ok) {
            results.push({ kind: "migrations", label, action: "failed", reason: colsRes.error ?? "" });
            continue;
        }
        const cols = colsRes.data;
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
            }
            catch (e) {
                results.push({
                    kind: "migrations",
                    label: perColLabel,
                    action: "failed",
                    reason: e.message,
                });
            }
        }
    }
    return results;
}
//# sourceMappingURL=register.js.map