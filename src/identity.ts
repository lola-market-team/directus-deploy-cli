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

export async function buildIdentity(
  client: DirectusClient,
  localPolicies: Record<string, unknown>[],
  localRoles: Record<string, unknown>[],
): Promise<IdentityIndex> {
  const [serverPolicies, serverRoles] = await Promise.all([
    listAll(client, "/policies"),
    listAll(client, "/roles"),
  ]);
  return {
    policySyncIdToName: collectNames(localPolicies),
    roleSyncIdToName: collectNames(localRoles),
    serverPolicyIdByName: indexByName(serverPolicies),
    serverRoleIdByName: indexByName(serverRoles),
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
