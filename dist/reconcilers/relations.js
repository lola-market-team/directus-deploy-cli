import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
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