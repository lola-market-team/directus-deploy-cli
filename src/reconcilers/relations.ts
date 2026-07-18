import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";

// Identifier whitelist for building raw ALTER TABLE ADD CONSTRAINT SQL. Every
// value we splice in comes from a snapshot JSON file in-repo (never user
// input), but constrain the shape to snake_case/alnum anyway so a typo can't
// escape into unquoted SQL.
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertIdent(name: string, kind: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`invalid ${kind} identifier for FK repair SQL: '${name}'`);
  }
  return name;
}

// Query information_schema.table_constraints for every FK on the given tables.
// Returns a Map<table, Set<constraint_name>>. Returns null if the target has
// no /raw-query/execute endpoint — callers then skip FK repair (drift stays
// invisible, same as before this fix). Batched so one RTT covers the whole
// reconcile pass.
async function loadFkConstraints(
  client: DirectusClient,
  tables: Iterable<string>,
): Promise<Map<string, Set<string>> | null> {
  const list = [...new Set(tables)].filter((t) => IDENT_RE.test(t));
  if (list.length === 0) return new Map();
  const inClause = list.map((t) => `'${t}'`).join(",");
  const query =
    `SELECT table_name, constraint_name FROM information_schema.table_constraints ` +
    `WHERE constraint_type = 'FOREIGN KEY' AND table_name IN (${inClause})`;
  try {
    const r = (await client.postRaw("/raw-query/execute", { query })) as {
      success?: boolean;
      results?: Array<{ success?: boolean; data?: unknown[] }>;
    };
    const inner = r?.results?.[0];
    if (!r?.success || !inner?.success) return null;
    const out = new Map<string, Set<string>>();
    for (const row of inner.data ?? []) {
      if (row && typeof row === "object" && "table_name" in row && "constraint_name" in row) {
        const rr = row as { table_name: unknown; constraint_name: unknown };
        const t = String(rr.table_name);
        if (!out.has(t)) out.set(t, new Set());
        out.get(t)!.add(String(rr.constraint_name));
      }
    }
    return out;
  } catch {
    return null;
  }
}

interface FkRepairInputs {
  collection: string;
  field: string;
  schema: Record<string, unknown>;
}

// Build ALTER TABLE … ADD CONSTRAINT … SQL from the snapshot schema block.
// Repair path used when directus_relations row exists but pg_constraint has no
// matching FK. Preferred over DELETE+POST /relations because:
//   1. GET /relations reads a cached SchemaOverview that doesn't reflect raw
//      ALTER TABLE, so Directus may skip re-creating the FK on POST if it
//      believes the constraint is already present.
//   2. Raw ADD CONSTRAINT is atomic — no window where relation is missing.
//   3. Leaves directus_relations untouched (which is correct — that row is
//      already accurate; only Postgres was out of sync).
function buildAddConstraintSql(input: FkRepairInputs): string {
  const collection = assertIdent(input.collection, "collection");
  const field = assertIdent(input.field, "field");
  const s = input.schema;
  const fkTable = assertIdent(String(s.foreign_key_table ?? ""), "foreign_key_table");
  const fkColumn = assertIdent(String(s.foreign_key_column ?? "id"), "foreign_key_column");
  const constraintName = assertIdent(
    String(s.constraint_name ?? `${collection}_${field}_foreign`),
    "constraint_name",
  );
  // ON DELETE / ON UPDATE are enum-restricted; validate exact set to keep SQL safe.
  const ALLOWED_ACTIONS = new Set(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]);
  const onDelete = String(s.on_delete ?? "NO ACTION").toUpperCase();
  const onUpdate = String(s.on_update ?? "NO ACTION").toUpperCase();
  if (!ALLOWED_ACTIONS.has(onDelete)) throw new Error(`invalid on_delete: '${onDelete}'`);
  if (!ALLOWED_ACTIONS.has(onUpdate)) throw new Error(`invalid on_update: '${onUpdate}'`);
  return (
    `ALTER TABLE "${collection}" ADD CONSTRAINT "${constraintName}" ` +
    `FOREIGN KEY ("${field}") REFERENCES "${fkTable}"("${fkColumn}") ` +
    `ON UPDATE ${onUpdate} ON DELETE ${onDelete}`
  );
}

export interface RelationReconcileInput {
  relationsByCollection: Map<string, Record<string, unknown>[]>;
  client: DirectusClient;
  opts: ApplyOptions;
}

export async function reconcileRelations(
  input: RelationReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];

  // Load pg_constraint FK state up front — needed for FK-drift detection
  // because Directus's GET /relations `.schema` block reads from a cached
  // SchemaOverview that isn't invalidated by raw ALTER TABLE. Only
  // information_schema.table_constraints is authoritative. (Empirically
  // verified against test.lola.market on 2026-07-18 for issue #16.)
  const tablesToQuery: string[] = [];
  for (const [collection, relations] of input.relationsByCollection) {
    if (input.opts.onlyCollections && !input.opts.onlyCollections.has(collection)) continue;
    const anyFkExpected = relations.some(
      (r) => (r as { schema?: Record<string, unknown> }).schema?.foreign_key_table !== undefined,
    );
    if (anyFkExpected) tablesToQuery.push(collection);
  }
  const pgFks = await loadFkConstraints(input.client, tablesToQuery);

  for (const [collection, relations] of input.relationsByCollection) {
    if (input.opts.onlyCollections && !input.opts.onlyCollections.has(collection)) continue;
    for (const desired of relations) {
      const field = String((desired as { field?: unknown }).field ?? "");
      if (!field) continue;
      const label = `relations/${collection}.${field}`;

      let existing: Record<string, unknown> | null;
      try {
        const got = await input.client.get(`/relations/${collection}/${field}`);
        existing = Array.isArray(got) ? null : got;
      } catch (e) {
        results.push({ kind: "relations", label, action: "failed", reason: (e as Error).message });
        continue;
      }

      const payload = sanitizeForWrite(desired as Record<string, unknown>);
      const desiredMeta = (payload.meta as Record<string, unknown> | undefined) ?? {};
      const existingMeta = (existing?.meta as Record<string, unknown> | undefined) ?? {};
      const desiredSchema = payload.schema as Record<string, unknown> | undefined;

      // FK drift: the snapshot expects a FK, but pg_constraint doesn't have
      // it. Only checked when we successfully loaded FK state (pgFks !== null)
      // AND the snapshot pins a foreign_key_table for this field.
      let fkDrift = false;
      if (existing !== null && pgFks && desiredSchema?.foreign_key_table) {
        const expected = String(
          desiredSchema.constraint_name ?? `${collection}_${field}_foreign`,
        );
        const actual = pgFks.get(collection);
        fkDrift = !actual || !actual.has(expected);
      }

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
      } else if (fkDrift) {
        if (!input.opts.dryRun) {
          try {
            const sql = buildAddConstraintSql({
              collection,
              field,
              schema: desiredSchema as Record<string, unknown>,
            });
            const r = (await input.client.postRaw("/raw-query/execute", { query: sql })) as {
              success?: boolean;
              results?: Array<{ success?: boolean; error?: string }>;
            };
            const inner = r?.results?.[0];
            if (!r?.success || !inner?.success) {
              const reason = inner?.error ?? "raw-query rejected ALTER TABLE";
              results.push({ kind: "relations", label, action: "failed", reason });
              continue;
            }
          } catch (e) {
            results.push({ kind: "relations", label, action: "failed", reason: (e as Error).message });
            continue;
          }
        }
        results.push({
          kind: "relations",
          label,
          action: "updated",
          reason: "FK constraint missing in Postgres — recreated via ALTER TABLE ADD CONSTRAINT",
        });
      } else if (diffSubset(desiredMeta, existingMeta)) {
        if (!input.opts.dryRun) {
          try {
            // Adopt-schema-only-FK case: when existing.meta is null (relation
            // exists as a Postgres FK constraint but has no directus_relations
            // row), Directus's PATCH endpoint attempts to INSERT the row. It
            // needs the top-level `.collection`/`.field` in the body to derive
            // `directus_relations.many_collection`. Sending only `{meta: ...}`
            // hits NOT_NULL_VIOLATION on many_collection.
            const patchBody = existingMeta && Object.keys(existingMeta).length > 0
              ? { meta: desiredMeta }
              : payload;
            await input.client.patch(`/relations/${collection}/${field}`, patchBody);
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
