import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";

// Roles are identity-by-name. UUID PK server-side; we resolve by name so the
// same JSON works across every env without a sync-id map.

export interface RoleReconcileInput {
  roles: Record<string, unknown>[];
  client: DirectusClient;
  opts: ApplyOptions;
}

async function listServerRoles(client: DirectusClient): Promise<Record<string, unknown>[]> {
  const raw = await client.get("/roles?limit=-1");
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

export async function reconcileRoles(input: RoleReconcileInput): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  let serverByName: Map<string, Record<string, unknown>> | null = null;
  const ensureServer = async () => {
    if (serverByName === null) serverByName = indexByName(await listServerRoles(input.client));
    return serverByName;
  };

  for (const desired of input.roles) {
    const name = String((desired as { name?: unknown }).name ?? "");
    if (!name) continue;
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
        } catch (e) {
          results.push({ kind: "roles", label, action: "failed", reason: (e as Error).message });
          continue;
        }
      }
      results.push({ kind: "roles", label, action: "created" });
    } else if (diffSubset(payload, existing)) {
      const id = String((existing as { id?: unknown }).id ?? "");
      if (!input.opts.dryRun) {
        try {
          await input.client.patch(`/roles/${id}`, payload);
        } catch (e) {
          results.push({ kind: "roles", label, action: "failed", reason: (e as Error).message });
          continue;
        }
      }
      results.push({ kind: "roles", label, action: "updated" });
    } else {
      results.push({ kind: "roles", label, action: "unchanged" });
    }
  }
  return results;
}
