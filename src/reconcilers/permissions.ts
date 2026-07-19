import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { diffSubset, formatDiffPath } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
import type { IdentityIndex } from "../identity.js";
import { resolvePolicySyncIdToServerId } from "../identity.js";

// Permissions are identity-by-(collection, action, policy_name). Auto-int PK,
// but the composite key is stable across envs. We resolve `policy` (_syncId)
// → server policy UUID via the identity index; that gives us the composite
// key for both server and local rows.

export interface PermissionReconcileInput {
  permissions: Record<string, unknown>[];
  identity: IdentityIndex;
  client: DirectusClient;
  opts: ApplyOptions;
}

async function listServerPermissions(client: DirectusClient): Promise<Record<string, unknown>[]> {
  const raw = await client.get("/permissions?limit=-1");
  if (raw === null) return [];
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const data = (raw as { data?: unknown }).data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function compositeKey(collection: string, action: string, policyId: string): string {
  return `${collection}::${action}::${policyId}`;
}

export async function reconcilePermissions(
  input: PermissionReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  const server = await listServerPermissions(input.client);

  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of server) {
    const c = String((row as { collection?: unknown }).collection ?? "");
    const a = String((row as { action?: unknown }).action ?? "");
    const p = String((row as { policy?: unknown }).policy ?? "");
    byKey.set(compositeKey(c, a, p), row);
  }

  for (const desired of input.permissions) {
    const collection = String((desired as { collection?: unknown }).collection ?? "");
    const action = String((desired as { action?: unknown }).action ?? "");
    const policySync = String((desired as { policy?: unknown }).policy ?? "");
    if (!collection || !action || !policySync) continue;

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
        } catch (e) {
          results.push({
            kind: "permissions",
            label,
            action: "failed",
            reason: (e as Error).message,
          });
          continue;
        }
      }
      results.push({ kind: "permissions", label, action: "created" });
    } else {
      const dp = diffSubset(payload, existing);
      if (dp) {
        const id = String((existing as { id?: unknown }).id ?? "");
        if (!input.opts.dryRun) {
          try {
            await input.client.patch(`/permissions/${id}`, payload);
          } catch (e) {
            results.push({
              kind: "permissions",
              label,
              action: "failed",
              reason: (e as Error).message,
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
      } else {
        results.push({ kind: "permissions", label, action: "unchanged" });
      }
    }
  }
  return results;
}
