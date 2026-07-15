import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
import { resolveRoleSyncIdToServerId } from "../identity.js";
async function listServerPolicies(client) {
    const raw = await client.get("/policies?limit=-1");
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
function resolveRolesFks(payload, identity, unresolved) {
    const roles = payload.roles;
    if (!Array.isArray(roles))
        return payload;
    const resolved = roles.map((entry) => {
        if (entry === null || typeof entry !== "object")
            return entry;
        const syncId = String(entry.role ?? "");
        if (!syncId)
            return entry;
        const realId = resolveRoleSyncIdToServerId(syncId, identity);
        if (realId === null) {
            unresolved.push(syncId);
            return entry;
        }
        return { ...entry, role: realId };
    });
    return { ...payload, roles: resolved };
}
export async function reconcilePolicies(input) {
    const results = [];
    const serverByName = indexByName(await listServerPolicies(input.client));
    for (const desired of input.policies) {
        const name = String(desired.name ?? "");
        if (!name)
            continue;
        const label = `policies/${name}`;
        const existing = serverByName.get(name) ?? null;
        const unresolved = [];
        const payload = resolveRolesFks(sanitizeForWrite(desired), input.identity, unresolved);
        if (unresolved.length) {
            results.push({
                kind: "policies",
                label,
                action: "failed",
                reason: `unresolved role _syncId(s): ${unresolved.join(", ")}`,
            });
            continue;
        }
        if (existing === null) {
            if (!input.opts.dryRun) {
                try {
                    await input.client.post("/policies", payload);
                }
                catch (e) {
                    results.push({ kind: "policies", label, action: "failed", reason: e.message });
                    continue;
                }
            }
            results.push({ kind: "policies", label, action: "created" });
            continue;
        }
        // Directus stores policy↔role as an M2M junction and reports `roles` on
        // GET as junction-row ids, but expects nested {role, sort, user} objects
        // on POST/PATCH. Shape mismatch → false-positive drift. Also, roles
        // assignments often drift server-side (users assigning roles ad-hoc);
        // ignoring `roles` in the update path keeps this reconciler focused on
        // the policy row itself. Junction sync is a future concern.
        const stripRoles = (obj) => {
            const { roles: _r, users: _u, permissions: _p, ...rest } = obj;
            return rest;
        };
        const desiredCmp = stripRoles(payload);
        const existingCmp = stripRoles(existing);
        if (diffSubset(desiredCmp, existingCmp)) {
            const id = String(existing.id ?? "");
            if (!input.opts.dryRun) {
                try {
                    await input.client.patch(`/policies/${id}`, desiredCmp);
                }
                catch (e) {
                    results.push({ kind: "policies", label, action: "failed", reason: e.message });
                    continue;
                }
            }
            results.push({ kind: "policies", label, action: "updated" });
        }
        else {
            results.push({ kind: "policies", label, action: "unchanged" });
        }
    }
    return results;
}
//# sourceMappingURL=policies.js.map