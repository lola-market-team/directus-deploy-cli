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

import type { DirectusClient } from "./types.js";

export interface IdentityIndex {
  policySyncIdToName: Map<string, string>;
  roleSyncIdToName: Map<string, string>;
  serverPolicyIdByName: Map<string, string>;
  serverRoleIdByName: Map<string, string>;
  // Flows + operations. Operations don't have a name — their identity within
  // a flow is the `key` field, and their identity across flows is
  // (flow_name, key). We index server ops by (flow_id, key) since a client
  // GET returns `flow` as the server flow id.
  flowSyncIdToName: Map<string, string>;
  serverFlowIdByName: Map<string, string>;
  opSyncIdToFlowAndKey: Map<string, { flowSyncId: string; key: string }>;
  serverOpIdByFlowIdAndKey: Map<string, string>; // key format: `${flowId}::${opKey}`
}

function collectNames(
  local: Record<string, unknown>[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of local) {
    const syncId = String((row as { _syncId?: unknown })._syncId ?? "");
    const name = String((row as { name?: unknown }).name ?? "");
    if (syncId && name) map.set(syncId, name);
  }
  return map;
}

async function listAll(
  client: DirectusClient,
  path: string,
): Promise<Record<string, unknown>[]> {
  // Directus REST returns paginated {data: [...]} at the collection root.
  // For our small system-collection sizes (policies ≤ ~50, roles ≤ ~20), one
  // GET with limit=-1 is fine.
  const raw = await client.get(`${path}?limit=-1&fields=id,name`);
  if (raw === null) return [];
  // client.get returns .data already unwrapped. But when the endpoint returns
  // an array-of-records that arrives as a plain array cast to
  // Record<string, unknown> by our current typing; the runtime shape is
  // actually unknown[]. Handle both.
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const data = (raw as { data?: unknown }).data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function indexByName(
  rows: Record<string, unknown>[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    const name = String((r as { name?: unknown }).name ?? "");
    const id = String((r as { id?: unknown }).id ?? "");
    if (name && id) map.set(name, id);
  }
  return map;
}

function collectOpSyncIdIndex(
  localOps: Record<string, unknown>[],
): Map<string, { flowSyncId: string; key: string }> {
  const map = new Map<string, { flowSyncId: string; key: string }>();
  for (const op of localOps) {
    const sync = String((op as { _syncId?: unknown })._syncId ?? "");
    const flow = String((op as { flow?: unknown }).flow ?? "");
    const key = String((op as { key?: unknown }).key ?? "");
    if (sync && flow && key) map.set(sync, { flowSyncId: flow, key });
  }
  return map;
}

function indexServerOps(
  serverOps: Record<string, unknown>[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const op of serverOps) {
    const id = String((op as { id?: unknown }).id ?? "");
    const flow = String((op as { flow?: unknown }).flow ?? "");
    const key = String((op as { key?: unknown }).key ?? "");
    if (id && flow && key) map.set(`${flow}::${key}`, id);
  }
  return map;
}

export async function buildIdentity(
  client: DirectusClient,
  localPolicies: Record<string, unknown>[],
  localRoles: Record<string, unknown>[],
  localFlows: Record<string, unknown>[] = [],
  localOps: Record<string, unknown>[] = [],
): Promise<IdentityIndex> {
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

export function resolvePolicySyncIdToServerId(
  syncId: string,
  idx: IdentityIndex,
): string | null {
  const name = idx.policySyncIdToName.get(syncId);
  if (!name) return null;
  return idx.serverPolicyIdByName.get(name) ?? null;
}

export function resolveRoleSyncIdToServerId(
  syncId: string,
  idx: IdentityIndex,
): string | null {
  const name = idx.roleSyncIdToName.get(syncId);
  if (!name) return null;
  return idx.serverRoleIdByName.get(name) ?? null;
}

export function resolveFlowSyncIdToServerId(
  syncId: string,
  idx: IdentityIndex,
): string | null {
  const name = idx.flowSyncIdToName.get(syncId);
  if (!name) return null;
  return idx.serverFlowIdByName.get(name) ?? null;
}

// Operation identity: local _syncId → (flow_syncId, key) → we resolve
// flow_syncId → server flow id → look up server op by (flow_id, key).
export function resolveOpSyncIdToServerId(
  syncId: string,
  idx: IdentityIndex,
): string | null {
  const local = idx.opSyncIdToFlowAndKey.get(syncId);
  if (!local) return null;
  const serverFlowId = resolveFlowSyncIdToServerId(local.flowSyncId, idx);
  if (!serverFlowId) return null;
  return idx.serverOpIdByFlowIdAndKey.get(`${serverFlowId}::${local.key}`) ?? null;
}
