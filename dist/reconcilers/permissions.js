import { diffSubset, formatDiffPath } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
import { resolvePolicySyncIdToServerId } from "../identity.js";
async function listServerPermissions(client) {
    const raw = await client.get("/permissions?limit=-1");
    if (raw === null)
        return [];
    if (Array.isArray(raw))
        return raw;
    const data = raw.data;
    return Array.isArray(data) ? data : [];
}
function compositeKey(collection, action, policyId) {
    return `${collection}::${action}::${policyId}`;
}
export async function reconcilePermissions(input) {
    const results = [];
    const server = await listServerPermissions(input.client);
    const byKey = new Map();
    for (const row of server) {
        const c = String(row.collection ?? "");
        const a = String(row.action ?? "");
        const p = String(row.policy ?? "");
        byKey.set(compositeKey(c, a, p), row);
    }
    for (const desired of input.permissions) {
        const collection = String(desired.collection ?? "");
        const action = String(desired.action ?? "");
        const policySync = String(desired.policy ?? "");
        if (!collection || !action || !policySync)
            continue;
        const policyServerId = resolvePolicySyncIdToServerId(policySync, input.identity);
        const label = `permissions/${collection}.${action}(${policySync.slice(0, 8)}…)`;
        if (policyServerId === null) {
            results.push({
                kind: "permissions",
                label,
                action: "failed",
                reason: `unresolved policy _syncId '${policySync}' — apply policies first`,
            });
            continue;
        }
        const payload = sanitizeForWrite(desired);
        payload.policy = policyServerId;
        const existing = byKey.get(compositeKey(collection, action, policyServerId)) ?? null;
        if (existing === null) {
            if (!input.opts.dryRun) {
                try {
                    await input.client.post("/permissions", payload);
                }
                catch (e) {
                    results.push({
                        kind: "permissions",
                        label,
                        action: "failed",
                        reason: e.message,
                    });
                    continue;
                }
            }
            results.push({ kind: "permissions", label, action: "created" });
        }
        else {
            const dp = diffSubset(payload, existing);
            if (dp) {
                const id = String(existing.id ?? "");
                if (!input.opts.dryRun) {
                    try {
                        await input.client.patch(`/permissions/${id}`, payload);
                    }
                    catch (e) {
                        results.push({
                            kind: "permissions",
                            label,
                            action: "failed",
                            reason: e.message,
                        });
                        continue;
                    }
                }
                results.push({
                    kind: "permissions",
                    label,
                    action: "updated",
                    reason: formatDiffPath(dp),
                });
            }
            else {
                results.push({ kind: "permissions", label, action: "unchanged" });
            }
        }
    }
    return results;
}
//# sourceMappingURL=permissions.js.map