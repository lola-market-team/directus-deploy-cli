import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
export async function reconcileCollections(input) {
    const results = [];
    for (const desired of input.collections) {
        const name = String(desired.collection ?? "");
        if (!name)
            continue;
        if (input.opts.onlyCollections && !input.opts.onlyCollections.has(name))
            continue;
        const label = `collections/${name}`;
        // Three-tier: adopted raw-SQL tables get delegated to register-table.mjs
        // (M4) — for M1 we surface the intent as a SKIPPED entry so nobody's
        // surprised.
        if (input.registerManifests.has(name)) {
            results.push({
                kind: "collections",
                label,
                action: "skipped",
                reason: "raw-SQL adopted — owned by register-table (v0.4/M4)",
            });
            continue;
        }
        let existing;
        try {
            const got = await input.client.get(`/collections/${name}`);
            existing = Array.isArray(got) ? null : got;
        }
        catch (e) {
            results.push({
                kind: "collections",
                label,
                action: "failed",
                reason: e.message,
            });
            continue;
        }
        const payload = sanitizeForWrite(desired);
        if (existing === null) {
            if (!input.opts.dryRun) {
                try {
                    await input.client.post("/collections", payload);
                }
                catch (e) {
                    results.push({
                        kind: "collections",
                        label,
                        action: "failed",
                        reason: e.message,
                    });
                    continue;
                }
            }
            results.push({ kind: "collections", label, action: "created" });
            continue;
        }
        const desiredMeta = payload.meta ?? {};
        const existingMeta = existing.meta ?? {};
        if (diffSubset(desiredMeta, existingMeta)) {
            if (!input.opts.dryRun) {
                try {
                    await input.client.patch(`/collections/${name}`, { meta: desiredMeta });
                }
                catch (e) {
                    results.push({
                        kind: "collections",
                        label,
                        action: "failed",
                        reason: e.message,
                    });
                    continue;
                }
            }
            results.push({ kind: "collections", label, action: "updated" });
        }
        else {
            results.push({ kind: "collections", label, action: "unchanged" });
        }
    }
    return results;
}
//# sourceMappingURL=collections.js.map