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
// Identity is `id` — Directus's real primary key. `_sync_id` is Tractr's own
// namespace and gets stripped before writes. Additive-only in v0: `delete` is
// honoured for the read side (server extras aren't flagged as drift) but
// nothing is DELETEd. If you need to remove a seed row, delete it from git
// AND from the server manually until we add a `--prune` flag.
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
async function listServer(client, collection) {
    const raw = await client.get(`/items/${collection}?limit=-1`);
    if (raw === null)
        return [];
    if (Array.isArray(raw))
        return raw;
    const data = raw.data;
    return Array.isArray(data) ? data : [];
}
function indexById(rows) {
    const map = new Map();
    for (const r of rows) {
        const id = r.id;
        if (id !== undefined && id !== null)
            map.set(String(id), r);
    }
    return map;
}
export async function reconcileSeeds(input) {
    const results = [];
    const files = await readSeedFiles(input.seedDir);
    if (files.length === 0)
        return results;
    for (const file of files) {
        const { collection } = file;
        const create = file.meta?.create !== false;
        const update = file.meta?.update !== false;
        let server;
        try {
            server = await listServer(input.client, collection);
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
        const byId = indexById(server);
        for (const rawRow of file.data ?? []) {
            const id = rawRow.id;
            if (id === undefined || id === null)
                continue;
            const label = `seeds/${collection}[${String(id)}]`;
            const payload = sanitizeSeedRow(rawRow);
            const existing = byId.get(String(id));
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
    return results;
}
//# sourceMappingURL=seeds.js.map