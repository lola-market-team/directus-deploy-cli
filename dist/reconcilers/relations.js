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
                        await input.client.patch(`/relations/${collection}/${field}`, { meta: desiredMeta });
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