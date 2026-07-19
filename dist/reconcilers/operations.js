import { diffSubset, formatDiffPath } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
import { resolveFlowSyncIdToServerId, resolveOpSyncIdToServerId, } from "../identity.js";
async function listServerOps(client) {
    const raw = await client.get("/operations?limit=-1");
    if (raw === null)
        return [];
    if (Array.isArray(raw))
        return raw;
    const data = raw.data;
    return Array.isArray(data) ? data : [];
}
function indexByFlowAndKey(rows) {
    const map = new Map();
    for (const r of rows) {
        const flow = String(r.flow ?? "");
        const key = String(r.key ?? "");
        if (flow && key)
            map.set(`${flow}::${key}`, r);
    }
    return map;
}
export async function reconcileOperationsPass1(input) {
    const results = [];
    const serverByCompositeKey = indexByFlowAndKey(await listServerOps(input.client));
    for (const desired of input.operations) {
        const opKey = String(desired.key ?? "");
        const flowSyncId = String(desired.flow ?? "");
        if (!opKey || !flowSyncId)
            continue;
        const label = `operations/${flowSyncId.slice(0, 8)}…/${opKey}`;
        const serverFlowId = resolveFlowSyncIdToServerId(flowSyncId, input.identity);
        if (!serverFlowId) {
            results.push({
                kind: "operations",
                label,
                action: "failed",
                reason: `unresolved flow _syncId '${flowSyncId}' — apply flows first`,
            });
            continue;
        }
        const payload = {
            ...sanitizeForWrite(desired),
            flow: serverFlowId,
            // First pass: null out the intra-flow refs; Pass 2 will PATCH them.
            resolve: null,
            reject: null,
        };
        const existing = serverByCompositeKey.get(`${serverFlowId}::${opKey}`) ?? null;
        if (existing === null) {
            if (!input.opts.dryRun) {
                try {
                    await input.client.post("/operations", payload);
                }
                catch (e) {
                    results.push({
                        kind: "operations",
                        label,
                        action: "failed",
                        reason: e.message,
                    });
                    continue;
                }
            }
            results.push({ kind: "operations", label, action: "created" });
            continue;
        }
        // Skip resolve/reject in diff — Pass 2 handles those.
        const { resolve: _dr, reject: _dj, ...desiredForDiff } = payload;
        const { resolve: _er, reject: _ej, ...existingForDiff } = existing;
        const dp = diffSubset(desiredForDiff, existingForDiff);
        if (dp) {
            const id = String(existing.id ?? "");
            if (!input.opts.dryRun) {
                try {
                    await input.client.patch(`/operations/${id}`, desiredForDiff);
                }
                catch (e) {
                    results.push({
                        kind: "operations",
                        label,
                        action: "failed",
                        reason: e.message,
                    });
                    continue;
                }
            }
            results.push({
                kind: "operations",
                label,
                action: "updated",
                reason: formatDiffPath(dp),
            });
        }
        else {
            results.push({ kind: "operations", label, action: "unchanged" });
        }
    }
    return results;
}
export async function reconcileOperationsPass2(input) {
    const results = [];
    const serverByCompositeKey = indexByFlowAndKey(await listServerOps(input.client));
    for (const desired of input.operations) {
        const opKey = String(desired.key ?? "");
        const flowSyncId = String(desired.flow ?? "");
        if (!opKey || !flowSyncId)
            continue;
        const resolveSync = desired.resolve;
        const rejectSync = desired.reject;
        if (resolveSync == null && rejectSync == null)
            continue; // nothing to link
        const label = `operations/${flowSyncId.slice(0, 8)}…/${opKey} (link refs)`;
        const serverFlowId = resolveFlowSyncIdToServerId(flowSyncId, input.identity);
        if (!serverFlowId)
            continue; // Pass 1 already flagged this
        const existing = serverByCompositeKey.get(`${serverFlowId}::${opKey}`);
        if (!existing)
            continue; // Pass 1 already flagged
        const resolveTarget = resolveSync
            ? resolveOpSyncIdToServerId(String(resolveSync), input.identity)
            : null;
        const rejectTarget = rejectSync
            ? resolveOpSyncIdToServerId(String(rejectSync), input.identity)
            : null;
        if (resolveSync && !resolveTarget) {
            results.push({
                kind: "operations",
                label,
                action: "failed",
                reason: `unresolved resolve _syncId '${resolveSync}'`,
            });
            continue;
        }
        if (rejectSync && !rejectTarget) {
            results.push({
                kind: "operations",
                label,
                action: "failed",
                reason: `unresolved reject _syncId '${rejectSync}'`,
            });
            continue;
        }
        const currentResolve = existing.resolve ?? null;
        const currentReject = existing.reject ?? null;
        if (currentResolve === resolveTarget && currentReject === rejectTarget)
            continue;
        if (!input.opts.dryRun) {
            const id = String(existing.id ?? "");
            try {
                await input.client.patch(`/operations/${id}`, {
                    resolve: resolveTarget,
                    reject: rejectTarget,
                });
            }
            catch (e) {
                results.push({
                    kind: "operations",
                    label,
                    action: "failed",
                    reason: e.message,
                });
                continue;
            }
        }
        results.push({ kind: "operations", label, action: "updated" });
    }
    return results;
}
//# sourceMappingURL=operations.js.map