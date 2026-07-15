import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
import { resolveOpSyncIdToServerId } from "../identity.js";
async function listServerFlows(client) {
    const raw = await client.get("/flows?limit=-1");
    if (raw === null)
        return [];
    if (Array.isArray(raw))
        return raw;
    const data = raw.data;
    return Array.isArray(data) ? data : [];
}
function indexByName(rows) {
    const map = new Map();
    for (const r of rows) {
        const n = String(r.name ?? "");
        if (n)
            map.set(n, r);
    }
    return map;
}
function stripSideEffects(obj) {
    // Directus emits `operations` (junction ids) on GET but we manage ops in
    // their own reconciler. Also strip `user_created` etc. via sanitize.
    const { operations: _o, ...rest } = obj;
    return rest;
}
export async function reconcileFlowsPass1(input) {
    const results = [];
    const serverByName = indexByName(await listServerFlows(input.client));
    for (const desired of input.flows) {
        const name = String(desired.name ?? "");
        if (!name)
            continue;
        const label = `flows/${name}`;
        const existing = serverByName.get(name) ?? null;
        const raw = sanitizeForWrite(desired);
        // Send with operation=null in the first pass so ops (which reference this
        // flow) can be created without racing the flow-op link.
        const payload = stripSideEffects({ ...raw, operation: null });
        if (existing === null) {
            if (!input.opts.dryRun) {
                try {
                    await input.client.post("/flows", payload);
                }
                catch (e) {
                    results.push({ kind: "flows", label, action: "failed", reason: e.message });
                    continue;
                }
            }
            results.push({ kind: "flows", label, action: "created" });
            continue;
        }
        const existingStripped = stripSideEffects(existing);
        // Skip `operation` in this pass — it's handled by Pass 2.
        const { operation: _do, ...desiredForDiff } = payload;
        const { operation: _eo, ...existingForDiff } = existingStripped;
        if (diffSubset(desiredForDiff, existingForDiff)) {
            const id = String(existing.id ?? "");
            if (!input.opts.dryRun) {
                try {
                    await input.client.patch(`/flows/${id}`, desiredForDiff);
                }
                catch (e) {
                    results.push({ kind: "flows", label, action: "failed", reason: e.message });
                    continue;
                }
            }
            results.push({ kind: "flows", label, action: "updated" });
        }
        else {
            results.push({ kind: "flows", label, action: "unchanged" });
        }
    }
    return results;
}
// Pass 2: after operations are reconciled, set each flow's `operation` FK to
// the resolved server op id.
export async function reconcileFlowsPass2(input) {
    const results = [];
    const serverByName = indexByName(await listServerFlows(input.client));
    for (const desired of input.flows) {
        const name = String(desired.name ?? "");
        if (!name)
            continue;
        const desiredOpSync = String(desired.operation ?? "");
        if (!desiredOpSync)
            continue; // flow with no entry op — nothing to link
        const existing = serverByName.get(name);
        if (!existing)
            continue; // Pass 1 already reported the failure
        const serverOpId = resolveOpSyncIdToServerId(desiredOpSync, input.identity);
        const currentOp = String(existing.operation ?? "");
        const label = `flows/${name} (link op)`;
        if (!serverOpId) {
            results.push({
                kind: "flows",
                label,
                action: "failed",
                reason: `unresolved entry op _syncId '${desiredOpSync}'`,
            });
            continue;
        }
        if (currentOp === serverOpId) {
            // already linked — no report entry (already counted in pass 1)
            continue;
        }
        if (!input.opts.dryRun) {
            const id = String(existing.id ?? "");
            try {
                await input.client.patch(`/flows/${id}`, { operation: serverOpId });
            }
            catch (e) {
                results.push({ kind: "flows", label, action: "failed", reason: e.message });
                continue;
            }
        }
        results.push({ kind: "flows", label, action: "updated" });
    }
    return results;
}
//# sourceMappingURL=flows.js.map