import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";

export interface RelationReconcileInput {
  relationsByCollection: Map<string, Record<string, unknown>[]>;
  client: DirectusClient;
  opts: ApplyOptions;
}

export async function reconcileRelations(
  input: RelationReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  for (const [collection, relations] of input.relationsByCollection) {
    if (input.opts.onlyCollections && !input.opts.onlyCollections.has(collection)) continue;
    for (const desired of relations) {
      const field = String((desired as { field?: unknown }).field ?? "");
      if (!field) continue;
      const label = `relations/${collection}.${field}`;

      let existing: Record<string, unknown> | null;
      try {
        existing = await input.client.get(`/relations/${collection}/${field}`);
      } catch (e) {
        results.push({ kind: "relations", label, action: "failed", reason: (e as Error).message });
        continue;
      }

      const payload = sanitizeForWrite(desired as Record<string, unknown>);
      const desiredMeta = (payload.meta as Record<string, unknown> | undefined) ?? {};
      const existingMeta = (existing?.meta as Record<string, unknown> | undefined) ?? {};

      if (existing === null) {
        if (!input.opts.dryRun) {
          try {
            await input.client.post("/relations", payload);
          } catch (e) {
            results.push({ kind: "relations", label, action: "failed", reason: (e as Error).message });
            continue;
          }
        }
        results.push({ kind: "relations", label, action: "created" });
      } else if (diffSubset(desiredMeta, existingMeta)) {
        if (!input.opts.dryRun) {
          try {
            await input.client.patch(`/relations/${collection}/${field}`, { meta: desiredMeta });
          } catch (e) {
            results.push({ kind: "relations", label, action: "failed", reason: (e as Error).message });
            continue;
          }
        }
        results.push({ kind: "relations", label, action: "updated" });
      } else {
        results.push({ kind: "relations", label, action: "unchanged" });
      }
    }
  }
  return results;
}
