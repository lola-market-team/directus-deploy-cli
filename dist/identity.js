// Resolve Tractr's `_syncId` foreign keys inside a payload to the real
// server-side ids/UUIDs, using name-based lookup on server state.
//
// The backend's directus_config/ has cross-references like:
//   permission.policy = "_sync_default_public_policy"   // policy _syncId
//   policy.roles      = [{ role: "_sync_default_admin_role", … }]  // role _syncId
//
// The map from `_syncId` → `name` is defined by the local JSON files. From
// there we look up the server id by name. That's how we stay compatible with
// existing snapshots without depending on Tractr's directus_sync_id_map table.
function collectNames(local) {
    const map = new Map();
    for (const row of local) {
        const syncId = String(row._syncId ?? "");
        const name = String(row.name ?? "");
        if (syncId && name)
            map.set(syncId, name);
    }
    return map;
}
async function listAll(client, path) {
    // Directus REST returns paginated {data: [...]} at the collection root.
    // For our small system-collection sizes (policies ≤ ~50, roles ≤ ~20), one
    // GET with limit=-1 is fine.
    const raw = await client.get(`${path}?limit=-1&fields=id,name`);
    if (raw === null)
        return [];
    // client.get returns .data already unwrapped. But when the endpoint returns
    // an array-of-records that arrives as a plain array cast to
    // Record<string, unknown> by our current typing; the runtime shape is
    // actually unknown[]. Handle both.
    if (Array.isArray(raw))
        return raw;
    const data = raw.data;
    return Array.isArray(data) ? data : [];
}
function indexByName(rows) {
    const map = new Map();
    for (const r of rows) {
        const name = String(r.name ?? "");
        const id = String(r.id ?? "");
        if (name && id)
            map.set(name, id);
    }
    return map;
}
function collectOpSyncIdIndex(localOps) {
    const map = new Map();
    for (const op of localOps) {
        const sync = String(op._syncId ?? "");
        const flow = String(op.flow ?? "");
        const key = String(op.key ?? "");
        if (sync && flow && key)
            map.set(sync, { flowSyncId: flow, key });
    }
    return map;
}
function indexServerOps(serverOps) {
    const map = new Map();
    for (const op of serverOps) {
        const id = String(op.id ?? "");
        const flow = String(op.flow ?? "");
        const key = String(op.key ?? "");
        if (id && flow && key)
            map.set(`${flow}::${key}`, id);
    }
    return map;
}
export async function buildIdentity(client, localPolicies, localRoles, localFlows = [], localOps = []) {
    const [serverPolicies, serverRoles, serverFlows, serverOps] = await Promise.all([
        listAll(client, "/policies"),
        listAll(client, "/roles"),
        localFlows.length
            ? client
                .get("/flows?limit=-1&fields=id,name")
                .then((r) => (Array.isArray(r) ? r : []))
            : Promise.resolve([]),
        localOps.length
            ? client
                .get("/operations?limit=-1&fields=id,flow,key")
                .then((r) => (Array.isArray(r) ? r : []))
            : Promise.resolve([]),
    ]);
    return {
        policySyncIdToName: collectNames(localPolicies),
        roleSyncIdToName: collectNames(localRoles),
        serverPolicyIdByName: indexByName(serverPolicies),
        serverRoleIdByName: indexByName(serverRoles),
        flowSyncIdToName: collectNames(localFlows),
        serverFlowIdByName: indexByName(serverFlows),
        opSyncIdToFlowAndKey: collectOpSyncIdIndex(localOps),
        serverOpIdByFlowIdAndKey: indexServerOps(serverOps),
    };
}
export function resolvePolicySyncIdToServerId(syncId, idx) {
    const name = idx.policySyncIdToName.get(syncId);
    if (!name)
        return null;
    return idx.serverPolicyIdByName.get(name) ?? null;
}
export function resolveRoleSyncIdToServerId(syncId, idx) {
    const name = idx.roleSyncIdToName.get(syncId);
    if (!name)
        return null;
    return idx.serverRoleIdByName.get(name) ?? null;
}
export function resolveFlowSyncIdToServerId(syncId, idx) {
    const name = idx.flowSyncIdToName.get(syncId);
    if (!name)
        return null;
    return idx.serverFlowIdByName.get(name) ?? null;
}
// Operation identity: local _syncId → (flow_syncId, key) → we resolve
// flow_syncId → server flow id → look up server op by (flow_id, key).
export function resolveOpSyncIdToServerId(syncId, idx) {
    const local = idx.opSyncIdToFlowAndKey.get(syncId);
    if (!local)
        return null;
    const serverFlowId = resolveFlowSyncIdToServerId(local.flowSyncId, idx);
    if (!serverFlowId)
        return null;
    return idx.serverOpIdByFlowIdAndKey.get(`${serverFlowId}::${local.key}`) ?? null;
}
//# sourceMappingURL=identity.js.map