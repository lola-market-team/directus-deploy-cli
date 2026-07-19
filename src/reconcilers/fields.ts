import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { diffSubset, formatDiffPath } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";

const FK_SCHEMA_KEYS = new Set([
  "foreign_key_column",
  "foreign_key_schema",
  "foreign_key_table",
  "constraint_name",
]);

function stripFkKeys(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!schema) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (FK_SCHEMA_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export interface FieldReconcileInput {
  fieldsByCollection: Map<string, Record<string, unknown>[]>;
  registerManifests: Set<string>;
  client: DirectusClient;
  opts: ApplyOptions;
}

export async function reconcileFields(input: FieldReconcileInput): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  for (const [collection, fields] of input.fieldsByCollection) {
    if (input.opts.onlyCollections && !input.opts.onlyCollections.has(collection)) continue;

    // Adopted raw-SQL tables — register-table.mjs owns the fields; skipping
    // avoids the classic "PATCH with type=unknown" cascade that broke pgvector
    // embeddings on test/staging.
    if (input.registerManifests.has(collection)) {
      results.push({
        kind: "fields",
        label: `fields/${collection}/*`,
        action: "skipped",
        reason: "raw-SQL adopted — owned by register-table",
      });
      continue;
    }

    for (const desired of fields) {
      const field = String((desired as { field?: unknown }).field ?? "");
      if (!field) continue;
      const label = `fields/${collection}.${field}`;

      let existing: Record<string, unknown> | null;
      try {
        const got = await input.client.get(`/fields/${collection}/${field}`);
        existing = Array.isArray(got) ? null : got;
      } catch (e) {
        results.push({ kind: "fields", label, action: "failed", reason: (e as Error).message });
        continue;
      }

      // Skip fields that Directus tracks as adopted-but-unregistered
      // (type=unknown, meta=null). Patching would silently promote them into
      // managed state and diverge from the DB.
      if (
        existing !== null &&
        (existing["type"] === "unknown" || existing["meta"] === null || existing["meta"] === undefined)
      ) {
        results.push({
          kind: "fields",
          label,
          action: "skipped",
          reason: "unregistered raw-SQL column (type=unknown)",
        });
        continue;
      }

      const payload = sanitizeForWrite(desired as Record<string, unknown>);
      const desiredMeta = (payload.meta as Record<string, unknown> | undefined) ?? {};

      // Only send schema when it *actually* differs. Re-asserting unchanged
      // schema on PK / sequence-backed columns makes Directus emit
      // ALTER COLUMN … DROP NOT NULL which Postgres rejects (verified today).
      // FK-triplet keys (foreign_key_*, constraint_name) are owned by
      // /relations, not /fields — PATCHing /fields with them is a no-op that
      // still reports UPDATED, causing perpetual drift. Strip them so the
      // fields diff ignores FK state entirely.
      const desiredSchema = stripFkKeys(payload.schema as Record<string, unknown> | undefined);
      const existingSchema = stripFkKeys(existing?.schema as Record<string, unknown> | undefined) ?? {};

      const desiredShape: Record<string, unknown> = {
        type: payload.type,
        meta: desiredMeta,
      };
      if (desiredSchema && (existing === null || diffSubset(desiredSchema, existingSchema))) {
        desiredShape["schema"] = desiredSchema;
      }

      if (existing === null) {
        if (!input.opts.dryRun) {
          try {
            await input.client.post(`/fields/${collection}`, payload);
          } catch (e) {
            results.push({ kind: "fields", label, action: "failed", reason: (e as Error).message });
            continue;
          }
        }
        results.push({ kind: "fields", label, action: "created" });
      } else {
        const dp = diffSubset(desiredShape, existing);
        if (dp) {
          if (!input.opts.dryRun) {
            try {
              await input.client.patch(`/fields/${collection}/${field}`, desiredShape);
            } catch (e) {
              results.push({ kind: "fields", label, action: "failed", reason: (e as Error).message });
              continue;
            }
          }
          results.push({
            kind: "fields",
            label,
            action: "updated",
            reason: formatDiffPath(dp),
          });
        } else {
          results.push({ kind: "fields", label, action: "unchanged" });
        }
      }
    }
  }
  return results;
}
