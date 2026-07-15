import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
async function listServerRoles(client) {
    const raw = await client.get("/roles?limit=-1");
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
export async function reconcileRoles(input) {
    const results = [];
    let serverByName = null;
    const ensureServer = async () => {
        if (serverByName === null)
            serverByName = indexByName(await listServerRoles(input.client));
        return serverByName;
    };
    for (const desired of input.roles) {
        const name = String(desired.name ?? "");
        if (!name)
            continue;
        const label = `roles/${name}`;
        const server = await ensureServer();
        const existing = server.get(name) ?? null;
        const payload = sanitizeForWrite(desired);
        // `parent` may reference a _syncId; the schema is nested by name in our
        // case (root roles have parent: null). Leaving as-is until we hit an env
        // where it's non-null — worth flagging on that day.
        if (existing === null) {
            if (!input.opts.dryRun) {
                try {
                    await input.client.post("/roles", payload);
                }
                catch (e) {
                    results.push({ kind: "roles", label, action: "failed", reason: e.message });
                    continue;
                }
            }
            results.push({ kind: "roles", label, action: "created" });
        }
        else if (diffSubset(payload, existing)) {
            const id = String(existing.id ?? "");
            if (!input.opts.dryRun) {
                try {
                    await input.client.patch(`/roles/${id}`, payload);
                }
                catch (e) {
                    results.push({ kind: "roles", label, action: "failed", reason: e.message });
                    continue;
                }
            }
            results.push({ kind: "roles", label, action: "updated" });
        }
        else {
            results.push({ kind: "roles", label, action: "unchanged" });
        }
    }
    return results;
}
//# sourceMappingURL=roles.js.map