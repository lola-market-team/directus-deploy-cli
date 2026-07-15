import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
export async function reconcileFields(input) {
    const results = [];
    for (const [collection, fields] of input.fieldsByCollection) {
        if (input.opts.onlyCollections && !input.opts.onlyCollections.has(collection))
            continue;
        // Adopted raw-SQL tables — register-table.mjs owns the fields; skipping
        // avoids the classic "PATCH with type=unknown" cascade that broke pgvector
        // embeddings on test/staging.
        if (input.registerManifests.has(collection)) {
            results.push({
                kind: "fields",
                label: `fields/${collection}/*`,
                action: "skipped",
                reason: "raw-SQL adopted — owned by register-table",
            });
            continue;
        }
        for (const desired of fields) {
            const field = String(desired.field ?? "");
            if (!field)
                continue;
            const label = `fields/${collection}.${field}`;
            let existing;
            try {
                const got = await input.client.get(`/fields/${collection}/${field}`);
                existing = Array.isArray(got) ? null : got;
            }
            catch (e) {
                results.push({ kind: "fields", label, action: "failed", reason: e.message });
                continue;
            }
            // Skip fields that Directus tracks as adopted-but-unregistered
            // (type=unknown, meta=null). Patching would silently promote them into
            // managed state and diverge from the DB.
            if (existing !== null &&
                (existing["type"] === "unknown" || existing["meta"] === null || existing["meta"] === undefined)) {
                results.push({
                    kind: "fields",
                    label,
                    action: "skipped",
                    reason: "unregistered raw-SQL column (type=unknown)",
                });
                continue;
            }
            const payload = sanitizeForWrite(desired);
            const desiredMeta = payload.meta ?? {};
            // Only send schema when it *actually* differs. Re-asserting unchanged
            // schema on PK / sequence-backed columns makes Directus emit
            // ALTER COLUMN … DROP NOT NULL which Postgres rejects (verified today).
            const desiredSchema = payload.schema ?? undefined;
            const existingSchema = existing?.schema ?? {};
            const desiredShape = {
                type: payload.type,
                meta: desiredMeta,
            };
            if (desiredSchema && (existing === null || diffSubset(desiredSchema, existingSchema))) {
                desiredShape["schema"] = desiredSchema;
            }
            if (existing === null) {
                if (!input.opts.dryRun) {
                    try {
                        await input.client.post(`/fields/${collection}`, payload);
                    }
                    catch (e) {
                        results.push({ kind: "fields", label, action: "failed", reason: e.message });
                        continue;
                    }
                }
                results.push({ kind: "fields", label, action: "created" });
            }
            else if (diffSubset(desiredShape, existing)) {
                if (!input.opts.dryRun) {
                    try {
                        await input.client.patch(`/fields/${collection}/${field}`, desiredShape);
                    }
                    catch (e) {
                        results.push({ kind: "fields", label, action: "failed", reason: e.message });
                        continue;
                    }
                }
                results.push({ kind: "fields", label, action: "updated" });
            }
            else {
                results.push({ kind: "fields", label, action: "unchanged" });
            }
        }
    }
    return results;
}
//# sourceMappingURL=fields.js.map