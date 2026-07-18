import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
// Compare only the FK-defining subset of a relation `.schema` block. Ignores
// server-only shape keys (`table`, `column`) that are echoed by
// information_schema but not part of what we want to reconcile.
function fkSchemaSubset(schema) {
    const keys = [
        "foreign_key_table",
        "foreign_key_column",
        "foreign_key_schema",
        "on_delete",
        "on_update",
    ];
    const out = {};
    for (const k of keys) {
        if (schema[k] !== undefined)
            out[k] = schema[k];
    }
    return out;
}
export async function reconcileRelations(input) {
    const results = [];
    for (const [collection, relations] of input.relationsByCollection) {
        if (input.opts.onlyCollections && !input.opts.onlyCollections.has(collection))
            continue;
        for (const desired of relations) {
            const field = String(desired.field ?? "");
            if (!field)
                continue;
            const label = `relations/${collection}.${field}`;
            let existing;
            try {
                const got = await input.client.get(`/relations/${collection}/${field}`);
                existing = Array.isArray(got) ? null : got;
            }
            catch (e) {
                results.push({ kind: "relations", label, action: "failed", reason: e.message });
                continue;
            }
            const payload = sanitizeForWrite(desired);
            const desiredMeta = payload.meta ?? {};
            const existingMeta = existing?.meta ?? {};
            const desiredSchema = payload.schema;
            const existingSchema = existing?.schema;
            // FK drift: directus_relations row exists but the Postgres FK
            // constraint is missing or points at the wrong target. Directus derives
            // GET /relations `.schema` from information_schema, so a null (or
            // mismatched) `.schema` is authoritative evidence that pg_constraint
            // and directus_relations have diverged. PATCH won't recreate the FK;
            // only DELETE+POST does (same code path the admin UI uses on relation
            // edit). See lola-market-team/directus-deploy-cli#16.
            const fkDrift = desiredSchema !== undefined &&
                (existingSchema == null ||
                    diffSubset(fkSchemaSubset(desiredSchema), fkSchemaSubset(existingSchema)));
            if (existing === null) {
                if (!input.opts.dryRun) {
                    try {
                        await input.client.post("/relations", payload);
                    }
                    catch (e) {
                        results.push({ kind: "relations", label, action: "failed", reason: e.message });
                        continue;
                    }
                }
                results.push({ kind: "relations", label, action: "created" });
            }
            else if (fkDrift) {
                if (!input.opts.dryRun) {
                    try {
                        await input.client.delete(`/relations/${collection}/${field}`);
                        await input.client.post("/relations", payload);
                    }
                    catch (e) {
                        results.push({ kind: "relations", label, action: "failed", reason: e.message });
                        continue;
                    }
                }
                results.push({
                    kind: "relations",
                    label,
                    action: "updated",
                    reason: "FK constraint missing/mismatched in Postgres — recreated via DELETE+POST",
                });
            }
            else if (diffSubset(desiredMeta, existingMeta)) {
                if (!input.opts.dryRun) {
                    try {
                        // Adopt-schema-only-FK case: when existing.meta is null (relation
                        // exists as a Postgres FK constraint but has no directus_relations
                        // row), Directus's PATCH endpoint attempts to INSERT the row. It
                        // needs the top-level `.collection`/`.field` in the body to derive
                        // `directus_relations.many_collection`. Sending only `{meta: ...}`
                        // hits NOT_NULL_VIOLATION on many_collection.
                        const patchBody = existingMeta && Object.keys(existingMeta).length > 0
                            ? { meta: desiredMeta }
                            : payload;
                        await input.client.patch(`/relations/${collection}/${field}`, patchBody);
                    }
                    catch (e) {
                        results.push({ kind: "relations", label, action: "failed", reason: e.message });
                        continue;
                    }
                }
                results.push({ kind: "relations", label, action: "updated" });
            }
            else {
                results.push({ kind: "relations", label, action: "unchanged" });
            }
        }
    }
    return results;
}
//# sourceMappingURL=relations.js.map