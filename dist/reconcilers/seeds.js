import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { diffSubset, formatDiffPath } from "../diff.js";
// Seed data reconciler for the LOLA convention (Tractr-style seed files under
// directus_config/seed/*.json). Each file shape:
//
//   {
//     "collection": "messaging_templates",
//     "meta": { "insert_order": 20, "preserve_ids": true,
//               "create": true, "update": true, "delete": true },
//     "data": [ {"id": 3, "_sync_id": "3", ...}, ... ]
//   }
//
// Row identity is the collection's real primary key, resolved per collection
// from /fields/<collection> (schema.is_primary_key) and falling back to `id`
// when unresolvable (#32 — `notification_types` keys on `key`, not `id`).
// `_sync_id` is Tractr's own namespace and gets stripped before writes.
// Deletion (#36): server rows absent from the seed are reported. For
// collections with meta.delete=true they surface as action "extra" (verify
// fails on them) and `apply --prune` DELETEs them, children-first (reverse
// insert_order). With meta.delete unset/false they surface as one aggregated
// "skipped" result per collection — visible, never drift, never deleted.
const SERVER_ONLY_SEED_KEYS = new Set([
    "_sync_id",
    "date_created",
    "user_created",
    "date_updated",
    "user_updated",
]);
async function readSeedFiles(dir) {
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
        try {
            const parsed = JSON.parse(await readFile(join(dir, f), "utf8"));
            if (parsed?.collection && Array.isArray(parsed.data))
                out.push(parsed);
        }
        catch {
            // let the reconciler surface a per-file failure below
        }
    }
    // Apply in the meta.insert_order the LOLA repo uses (lower first).
    out.sort((a, b) => (a.meta?.insert_order ?? 0) - (b.meta?.insert_order ?? 0));
    return out;
}
function sanitizeSeedRow(row) {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
        if (SERVER_ONLY_SEED_KEYS.has(k))
            continue;
        out[k] = v;
    }
    return out;
}
// Restrict the read to the columns the seed manages (#37). diffSubset only
// ever compares seed-present keys, so anything wider is wasted transfer — and
// on wide collections it's pathological (a pgvector column turned the LOLA
// `categories` read into ~50 MB and OOM'd the instance on every plan).
function seedManagedFields(file, pk) {
    const keys = new Set([pk]);
    for (const row of file.data ?? []) {
        for (const k of Object.keys(row)) {
            if (!SERVER_ONLY_SEED_KEYS.has(k))
                keys.add(k);
        }
    }
    return [...keys];
}
async function listServer(client, collection, fields) {
    const fieldsParam = fields.length
        ? `&fields=${encodeURIComponent(fields.join(","))}`
        : "";
    const raw = await client.get(`/items/${collection}?limit=-1${fieldsParam}`);
    if (raw === null)
        return [];
    if (Array.isArray(raw))
        return raw;
    const data = raw.data;
    return Array.isArray(data) ? data : [];
}
function indexByPk(rows, pk) {
    const map = new Map();
    for (const r of rows) {
        const v = r[pk];
        if (v !== undefined && v !== null)
            map.set(String(v), r);
    }
    return map;
}
// PK per collection via /fields/<collection>. Falls back to `id` when the
// endpoint is unreachable or reports no PK — never throws, so a lookup
// hiccup degrades to the historical behaviour instead of failing the file.
export async function resolvePrimaryKey(client, collection, cache) {
    const hit = cache.get(collection);
    if (hit !== undefined)
        return hit;
    let pk = "id";
    try {
        const raw = await client.get(`/fields/${collection}`);
        if (Array.isArray(raw)) {
            const pkField = raw.find((f) => {
                // Some schema inspectors report 1 / "YES" instead of boolean true.
                const v = f.schema?.is_primary_key;
                return v === true || v === 1 || v === "YES";
            });
            if (pkField && typeof pkField.field === "string")
                pk = pkField.field;
        }
    }
    catch {
        // fall back to `id`
    }
    cache.set(collection, pk);
    return pk;
}
export async function reconcileSeeds(input) {
    const results = [];
    const files = await readSeedFiles(input.seedDir);
    if (files.length === 0)
        return results;
    const pkCache = new Map();
    for (const file of files) {
        const { collection } = file;
        const pk = await resolvePrimaryKey(input.client, collection, pkCache);
        const create = file.meta?.create !== false;
        const update = file.meta?.update !== false;
        let server;
        try {
            server = await listServer(input.client, collection, seedManagedFields(file, pk));
        }
        catch (e) {
            results.push({
                kind: "seeds",
                label: `seeds/${collection}`,
                action: "failed",
                reason: e.message,
            });
            continue;
        }
        const byPk = indexByPk(server, pk);
        for (const [i, rawRow] of (file.data ?? []).entries()) {
            const id = rawRow[pk];
            if (id === undefined || id === null) {
                // #32: never skip silently — an invisible row is indistinguishable
                // from "nothing to do" in plan/apply output.
                results.push({
                    kind: "seeds",
                    label: `seeds/${collection}[row ${i}]`,
                    action: "skipped",
                    reason: `row has no value for primary key '${pk}'`,
                });
                continue;
            }
            const label = `seeds/${collection}[${String(id)}]`;
            const payload = sanitizeSeedRow(rawRow);
            const existing = byPk.get(String(id));
            if (existing === undefined) {
                if (!create) {
                    results.push({
                        kind: "seeds",
                        label,
                        action: "skipped",
                        reason: "meta.create=false",
                    });
                    continue;
                }
                if (!input.opts.dryRun) {
                    try {
                        await input.client.post(`/items/${collection}`, payload);
                    }
                    catch (e) {
                        results.push({
                            kind: "seeds",
                            label,
                            action: "failed",
                            reason: e.message,
                        });
                        continue;
                    }
                }
                results.push({ kind: "seeds", label, action: "created" });
                continue;
            }
            if (!update) {
                results.push({ kind: "seeds", label, action: "unchanged" });
                continue;
            }
            const dp = diffSubset(payload, existing);
            if (dp) {
                if (!input.opts.dryRun) {
                    try {
                        await input.client.patch(`/items/${collection}/${encodeURIComponent(String(id))}`, payload);
                    }
                    catch (e) {
                        results.push({
                            kind: "seeds",
                            label,
                            action: "failed",
                            reason: e.message,
                        });
                        continue;
                    }
                }
                results.push({ kind: "seeds", label, action: "updated", reason: formatDiffPath(dp) });
            }
            else {
                results.push({ kind: "seeds", label, action: "unchanged" });
            }
        }
    }
    const byCollection = new Map();
    for (const file of files) {
        const pk = await resolvePrimaryKey(input.client, file.collection, pkCache);
        let c = byCollection.get(file.collection);
        if (!c) {
            c = {
                collection: file.collection,
                pk,
                seedPks: new Set(),
                deleteEnabled: false,
                insertOrder: file.meta?.insert_order ?? 0,
            };
            byCollection.set(file.collection, c);
        }
        if (file.meta?.delete === true)
            c.deleteEnabled = true;
        c.insertOrder = Math.max(c.insertOrder, file.meta?.insert_order ?? 0);
        for (const row of file.data ?? []) {
            const id = row[pk];
            if (id !== undefined && id !== null)
                c.seedPks.add(String(id));
        }
    }
    const collections = [...byCollection.values()].sort((a, b) => b.insertOrder - a.insertOrder);
    for (const c of collections) {
        let server;
        try {
            server = await listServer(input.client, c.collection, [c.pk]);
        }
        catch (e) {
            results.push({
                kind: "seeds",
                label: `seeds/${c.collection}`,
                action: "failed",
                reason: `extras check: ${e.message}`,
            });
            continue;
        }
        const extras = server
            .map((r) => r[c.pk])
            .filter((v) => v !== undefined && v !== null && !c.seedPks.has(String(v)));
        if (extras.length === 0)
            continue;
        if (!c.deleteEnabled) {
            // meta.delete is off, so prune will never touch these. Report the count
            // structurally as well as in prose: `skipped` alone made this invisible
            // to overview, which meant a collection could diverge indefinitely and
            // still render "in sync".
            results.push({
                kind: "seeds",
                label: `seeds/${c.collection}`,
                action: "skipped",
                reason: `${extras.length} server row(s) not in seed (meta.delete not enabled)`,
                unmanaged: extras.length,
            });
            continue;
        }
        for (const id of extras) {
            const label = `seeds/${c.collection}[${String(id)}]`;
            if (!input.opts.prune) {
                results.push({
                    kind: "seeds",
                    label,
                    action: "extra",
                    reason: "server row not in seed — apply --prune to delete",
                });
                continue;
            }
            if (!input.opts.dryRun) {
                try {
                    await input.client.delete(`/items/${c.collection}/${encodeURIComponent(String(id))}`);
                }
                catch (e) {
                    results.push({ kind: "seeds", label, action: "failed", reason: e.message });
                    continue;
                }
            }
            results.push({ kind: "seeds", label, action: "deleted" });
        }
    }
    return results;
}
//# sourceMappingURL=seeds.js.map