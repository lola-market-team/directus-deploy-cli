import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { diffSubset, formatDiffPath } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
import type { IdentityIndex } from "../identity.js";
import { resolveRoleSyncIdToServerId } from "../identity.js";

// Policies are identity-by-name. UUID PK server-side. The tricky bit is
// `roles: [{role: <_syncId>}]` — Tractr's cross-file FK. We resolve those to
// server role UUIDs before writing.

export interface PolicyReconcileInput {
  policies: Record<string, unknown>[];
  identity: IdentityIndex;
  client: DirectusClient;
  opts: ApplyOptions;
}

async function listServerPolicies(client: DirectusClient): Promise<Record<string, unknown>[]> {
  const raw = await client.get("/policies?limit=-1");
  if (raw === null) return [];
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const data = (raw as { data?: unknown }).data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function indexByName(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const n = String((r as { name?: unknown }).name ?? "");
    if (n) map.set(n, r);
  }
  return map;
}

function resolveRolesFks(
  payload: Record<string, unknown>,
  identity: IdentityIndex,
  unresolved: string[],
): Record<string, unknown> {
  const roles = payload.roles;
  if (!Array.isArray(roles)) return payload;
  const resolved = roles.map((entry) => {
    if (entry === null || typeof entry !== "object") return entry;
    const syncId = String((entry as { role?: unknown }).role ?? "");
    if (!syncId) return entry;
    const realId = resolveRoleSyncIdToServerId(syncId, identity);
    if (realId === null) {
      unresolved.push(syncId);
      return entry;
    }
    return { ...(entry as Record<string, unknown>), role: realId };
  });
  return { ...payload, roles: resolved };
}

export async function reconcilePolicies(input: PolicyReconcileInput): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  const serverByName = indexByName(await listServerPolicies(input.client));

  for (const desired of input.policies) {
    const name = String((desired as { name?: unknown }).name ?? "");
    if (!name) continue;
    const label = `policies/${name}`;
    const existing = serverByName.get(name) ?? null;

    const unresolved: string[] = [];
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
        } catch (e) {
          results.push({ kind: "policies", label, action: "failed", reason: (e as Error).message });
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
    const stripRoles = (obj: Record<string, unknown>): Record<string, unknown> => {
      const { roles: _r, users: _u, permissions: _p, ...rest } = obj;
      return rest;
    };
    const desiredCmp = stripRoles(payload);
    const existingCmp = stripRoles(existing);

    const dp = diffSubset(desiredCmp, existingCmp);
    if (dp) {
      const id = String((existing as { id?: unknown }).id ?? "");
      if (!input.opts.dryRun) {
        try {
          await input.client.patch(`/policies/${id}`, desiredCmp);
        } catch (e) {
          results.push({ kind: "policies", label, action: "failed", reason: (e as Error).message });
          continue;
        }
      }
      results.push({ kind: "policies", label, action: "updated", reason: formatDiffPath(dp) });
    } else {
      results.push({ kind: "policies", label, action: "unchanged" });
    }
  }
  return results;
}
