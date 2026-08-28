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

// A definition that cannot correspond to a real column, and so can never
// collide with the DDL a migration owns. Two shapes qualify:
//   schema === null          — alias fields: o2m/m2m, presentation
//   special includes no-data — computed fields an extension hydrates at read
//                              time (their snapshot JSON may still carry a
//                              vestigial schema block from an env where the
//                              column got created by hand).
// A definition with a real schema block and no column is NOT column-less:
// that is a missing migration, and creating the column here would be the
// double-write hazard CLAUDE.md warns about.
function isColumnless(desired: Record<string, unknown>): boolean {
  if (desired["schema"] === null) return true;
  const meta = desired["meta"] as Record<string, unknown> | null | undefined;
  const special = meta?.["special"];
  return Array.isArray(special) && special.includes("no-data");
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

    // Adopted raw-SQL tables — the register reconciler owns the *columns*;
    // skipping them avoids the classic "PATCH with type=unknown" cascade that
    // broke pgvector embeddings on test/staging.
    //
    // Column-less definitions are the exception and must still be applied.
    // The register reconciler sources its work from information_schema.columns,
    // so a field with no column behind it is invisible to it — and the fields
    // reconciler used to skip the whole collection, leaving nothing on the
    // deploy path able to create one. That hole is how the computed `rentals`
    // fields (quote_amount_cents & co.) reached prod unregistered: the
    // definitions were in git the entire time, and every apply reported clean.
    const adopted = input.registerManifests.has(collection);
    let pending = fields;
    if (adopted) {
      pending = fields.filter(isColumnless);
      const owned = fields.length - pending.length;
      if (owned > 0) {
        results.push({
          kind: "fields",
          label: `fields/${collection}/*`,
          action: "skipped",
          reason: `raw-SQL adopted — ${owned} column-backed field(s) owned by register-table`,
        });
      }
    }

    for (const desired of pending) {
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

      // Skip columns Directus cannot type. type=unknown means the DB column
      // exists but Directus has no mapping for it (pgvector is the case that
      // broke embeddings on test/staging) — asserting a type from the
      // snapshot would try to ALTER a column Directus doesn't understand.
      //
      // meta=null ALONE is a different state and must NOT be skipped. It means
      // Directus typed the column fine but there is no directus_fields row —
      // i.e. the column is simply unregistered. Register-manifest-owned tables
      // already returned above, so reaching here means the snapshot is the
      // declared owner and PATCH is exactly how the field gets its row.
      // Skipping it was self-perpetuating: the field stayed unregistered
      // because it was unregistered, reported `skipped` (never `failed`), and
      // so every apply looked clean while the column stayed invisible to the
      // API, GraphQL and the admin UI. That is how directus_users.charges_vat
      // / org_type / zvr sat unregistered on prod for months.
      if (existing !== null && existing["type"] === "unknown") {
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

      // Never send a schema block for a column-less field, even when the
      // snapshot JSON carries one. Directus reads `schema` as an instruction to
      // create the column, so forwarding a vestigial block turns a computed
      // field into a real column shadowed by the read hook that hydrates it —
      // and a permanent double-write against whatever else owns that table.
      if (isColumnless(desired as Record<string, unknown>)) payload["schema"] = null;

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
          // Distinguish "this column had no directus_fields row at all" from an
          // ordinary meta drift. Both are a PATCH, but only the first one means
          // the field was invisible to the API until now — worth saying so in
          // the deploy log rather than reporting it as `meta.note` drift.
          const wasUnregistered = existing["meta"] === null || existing["meta"] === undefined;
          results.push({
            kind: "fields",
            label,
            action: "updated",
            reason: wasUnregistered
              ? "registered previously-unmanaged column (no directus_fields row)"
              : formatDiffPath(dp),
          });
        } else {
          results.push({ kind: "fields", label, action: "unchanged" });
        }
      }
    }
  }
  return results;
}
