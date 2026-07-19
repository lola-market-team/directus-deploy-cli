import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { diffSubset, formatDiffPath } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";

export interface CollectionReconcileInput {
  collections: Record<string, unknown>[];
  registerManifests: Set<string>;
  // Per-collection field snapshots, used only at CREATE time so Directus
  // provisions the intended PK shape. Without a `fields` array in the
  // POST /collections payload, Directus falls back to an auto-generated
  // integer PK — a subsequent PATCH to convert `id` to (e.g.) a uuid PK
  // fails with "column is in a primary key". Optional for callers that only
  // need to reconcile meta on already-existing collections.
  fieldsByCollection?: Map<string, Record<string, unknown>[]>;
  client: DirectusClient;
  opts: ApplyOptions;
}

export async function reconcileCollections(
  input: CollectionReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  for (const desired of input.collections) {
    const name = String((desired as { collection?: unknown }).collection ?? "");
    if (!name) continue;
    if (input.opts.onlyCollections && !input.opts.onlyCollections.has(name)) continue;
    const label = `collections/${name}`;

    // Three-tier: adopted raw-SQL tables get delegated to register-table.mjs
    // (M4) — for M1 we surface the intent as a SKIPPED entry so nobody's
    // surprised.
    if (input.registerManifests.has(name)) {
      results.push({
        kind: "collections",
        label,
        action: "skipped",
        reason: "raw-SQL adopted — owned by register-table (v0.4/M4)",
      });
      continue;
    }

    let existing: Record<string, unknown> | null;
    try {
      const got = await input.client.get(`/collections/${name}`);
      existing = Array.isArray(got) ? null : got;
    } catch (e) {
      results.push({
        kind: "collections",
        label,
        action: "failed",
        reason: (e as Error).message,
      });
      continue;
    }

    const payload = sanitizeForWrite(desired as Record<string, unknown>);

    if (existing === null) {
      // Inline the snapshot's fields so Directus creates the collection with
      // its intended PK (and other schema-critical shape). Fields are
      // sanitized (strips `id`/`_syncId`) and stripped of `collection` since
      // that's implied by the parent. If no fields snapshot is available for
      // this collection, we fall back to the plain payload — Directus will
      // pick its default (integer auto-increment PK), and the fields
      // reconciler will attempt to fill in the rest afterwards.
      const snapshotFields = input.fieldsByCollection?.get(name);
      if (snapshotFields && snapshotFields.length > 0) {
        payload["fields"] = snapshotFields.map((f) => {
          const cleaned = sanitizeForWrite(f as Record<string, unknown>);
          delete cleaned["collection"];
          return cleaned;
        });
      }
      if (!input.opts.dryRun) {
        try {
          await input.client.post("/collections", payload);
        } catch (e) {
          results.push({
            kind: "collections",
            label,
            action: "failed",
            reason: (e as Error).message,
          });
          continue;
        }
      }
      results.push({ kind: "collections", label, action: "created" });
      continue;
    }

    const desiredMeta = (payload.meta as Record<string, unknown> | undefined) ?? {};
    const existingMeta = (existing.meta as Record<string, unknown> | undefined) ?? {};
    const dp = diffSubset(desiredMeta, existingMeta);
    if (dp) {
      if (!input.opts.dryRun) {
        try {
          await input.client.patch(`/collections/${name}`, { meta: desiredMeta });
        } catch (e) {
          results.push({
            kind: "collections",
            label,
            action: "failed",
            reason: (e as Error).message,
          });
          continue;
        }
      }
      results.push({
        kind: "collections",
        label,
        action: "updated",
        reason: `meta.${formatDiffPath(dp)}`,
      });
    } else {
      results.push({ kind: "collections", label, action: "unchanged" });
    }
  }
  return results;
}
