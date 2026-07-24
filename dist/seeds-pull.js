// seeds pull (#37) — regenerate a Tractr-style seed file from a live target.
// The seed-side sibling of `snapshot pull`: fetches the collection restricted
// to the seed-managed columns and rewrites directus_config/seed/<collection>.json
// deterministically, preserving an existing file's `meta` block.
//
// Ordering contract: parents before children (topo over the self-referencing
// parent field, when one is present in the pulled columns) so a fresh env can
// insert in file order without tripping the FK; PK-ascending within a level
// for stable git diffs.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolvePrimaryKey } from "./reconcilers/seeds.js";
async function readExisting(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return null;
    }
}
function deriveFields(existing) {
    const keys = new Set();
    for (const row of existing.data ?? []) {
        for (const k of Object.keys(row))
            if (k !== "_sync_id")
                keys.add(k);
    }
    return [...keys];
}
function topoSort(rows, pk, parentField) {
    const byPkAsc = (a, b) => {
        const av = a[pk];
        const bv = b[pk];
        return av < bv ? -1 : av > bv ? 1 : 0;
    };
    if (!parentField)
        return [...rows].sort(byPkAsc);
    const byId = new Map(rows.map((r) => [String(r[pk]), r]));
    const level = new Map();
    const levelOf = (r) => {
        const id = String(r[pk]);
        const hit = level.get(id);
        if (hit !== undefined)
            return hit;
        level.set(id, 0); // cycle guard: a parent loop degrades to level 0
        const parent = r[parentField];
        const parentRow = parent === null || parent === undefined ? undefined : byId.get(String(parent));
        const l = parentRow ? levelOf(parentRow) + 1 : 0;
        level.set(id, l);
        return l;
    };
    return [...rows].sort((a, b) => levelOf(a) - levelOf(b) || byPkAsc(a, b));
}
export async function pullSeed(input) {
    const path = join(input.seedDir, `${input.collection}.json`);
    const existing = await readExisting(path);
    const pk = await resolvePrimaryKey(input.client, input.collection, new Map());
    let fields = input.fields ?? (existing ? deriveFields(existing) : []);
    if (fields.length === 0) {
        throw new Error(`seeds pull ${input.collection}: no --fields given and no existing seed file to derive them from`);
    }
    if (!fields.includes(pk))
        fields = [pk, ...fields];
    const params = new URLSearchParams({ fields: fields.join(","), limit: "-1" });
    if (input.filter)
        params.set("filter", input.filter);
    const raw = await input.client.get(`/items/${input.collection}?${params.toString()}`);
    const rows = (Array.isArray(raw) ? raw : (raw?.data ?? []));
    if (!Array.isArray(rows))
        throw new Error(`seeds pull ${input.collection}: unexpected response shape`);
    const seen = new Set();
    for (const r of rows) {
        const id = String(r[pk]);
        if (seen.has(id)) {
            // preserve_ids seeds never converge with duplicate ids — hard error,
            // same contract as the LOLA fsm:drift §8 gate.
            throw new Error(`seeds pull ${input.collection}: duplicate ${pk}=${id} on the target`);
        }
        seen.add(id);
    }
    const parentField = input.parentField ?? (fields.includes("parent_id") ? "parent_id" : null);
    const ordered = topoSort(rows, pk, parentField).map((r) => {
        const out = {};
        for (const f of fields)
            out[f] = r[f] ?? null;
        return out;
    });
    const meta = existing?.meta ?? {
        insert_order: input.insertOrder ?? 50,
        preserve_ids: true,
        create: true,
        update: true,
        delete: false,
    };
    const body = { collection: input.collection, meta, data: ordered };
    await writeFile(path, JSON.stringify(body, null, 2) + "\n", "utf8");
    return { path, rows: ordered.length, fields };
}
//# sourceMappingURL=seeds-pull.js.map