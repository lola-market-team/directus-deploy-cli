import { diffSubset, formatDiffPath } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
// Identifier whitelist for building raw ALTER TABLE ADD CONSTRAINT SQL. Every
// value we splice in comes from a snapshot JSON file in-repo (never user
// input), but constrain the shape to snake_case/alnum anyway so a typo can't
// escape into unquoted SQL. Values also flow into a single-quoted SQL literal
// inside loadFkConstraints — the same regex is the gate for both paths.
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function assertIdent(name, kind) {
    if (!IDENT_RE.test(name)) {
        throw new Error(`invalid ${kind} identifier for FK repair SQL: '${name}'`);
    }
    return name;
}
// Load every FK on the given tables, keyed by (table, column) — NOT by
// constraint_name. Constraint names are cosmetic: a snapshot that pins
// `<coll>_<field>_fkey` while Postgres has `<coll>_<field>_foreign` should
// NOT report drift as long as the column-level FK relationship matches.
// Returns null when /raw-query/execute is unavailable so callers can skip
// FK checks gracefully. See issues #18, #19.
async function loadFkConstraints(client, tables) {
    // Filter identifiers before we splice them into SQL literals below. The
    // in-clause uses single-quoted strings; combined with IDENT_RE the values
    // are safe. Same defense applies in buildAddConstraintSql.
    const list = [...new Set(tables)].filter((t) => IDENT_RE.test(t));
    if (list.length === 0)
        return new Map();
    const inClause = list.map((t) => `'${t}'`).join(",");
    // information_schema join: table_constraints (kind), key_column_usage
    // (child column), constraint_column_usage (parent table+column). Filter
    // to public schema — non-public FKs aren't supported (#20).
    const query = `SELECT tc.table_name, kcu.column_name, tc.constraint_name, ` +
        `ccu.table_name AS referenced_table, ccu.column_name AS referenced_column ` +
        `FROM information_schema.table_constraints tc ` +
        `JOIN information_schema.key_column_usage kcu ` +
        `ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema ` +
        `JOIN information_schema.constraint_column_usage ccu ` +
        `ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema ` +
        `WHERE tc.constraint_type = 'FOREIGN KEY' ` +
        `AND tc.table_schema = 'public' ` +
        `AND tc.table_name IN (${inClause})`;
    try {
        const r = (await client.postRaw("/raw-query/execute", { query }));
        const inner = r?.results?.[0];
        if (!r?.success || !inner?.success)
            return null;
        const out = new Map();
        for (const row of inner.data ?? []) {
            if (row && typeof row === "object") {
                const rr = row;
                const table = String(rr.table_name ?? "");
                const column = String(rr.column_name ?? "");
                if (!table || !column)
                    continue;
                if (!out.has(table))
                    out.set(table, new Map());
                out.get(table).set(column, {
                    referenced_table: String(rr.referenced_table ?? ""),
                    referenced_column: String(rr.referenced_column ?? ""),
                    constraint_name: String(rr.constraint_name ?? ""),
                });
            }
        }
        return out;
    }
    catch {
        return null;
    }
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
function buildAddConstraintSql(input) {
    const collection = assertIdent(input.collection, "collection");
    const field = assertIdent(input.field, "field");
    const s = input.schema;
    const fkTable = assertIdent(String(s.foreign_key_table ?? ""), "foreign_key_table");
    const fkColumn = assertIdent(String(s.foreign_key_column ?? "id"), "foreign_key_column");
    const constraintName = assertIdent(String(s.constraint_name ?? `${collection}_${field}_foreign`), "constraint_name");
    // ON DELETE / ON UPDATE are enum-restricted; validate exact set to keep SQL safe.
    const ALLOWED_ACTIONS = new Set(["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"]);
    const onDelete = String(s.on_delete ?? "NO ACTION").toUpperCase();
    const onUpdate = String(s.on_update ?? "NO ACTION").toUpperCase();
    if (!ALLOWED_ACTIONS.has(onDelete))
        throw new Error(`invalid on_delete: '${onDelete}'`);
    if (!ALLOWED_ACTIONS.has(onUpdate))
        throw new Error(`invalid on_update: '${onUpdate}'`);
    return (`ALTER TABLE "${collection}" ADD CONSTRAINT "${constraintName}" ` +
        `FOREIGN KEY ("${field}") REFERENCES "${fkTable}"("${fkColumn}") ` +
        `ON UPDATE ${onUpdate} ON DELETE ${onDelete}`);
}
// Best-effort diagnostic on FK-repair failure. ALTER TABLE ADD CONSTRAINT
// fails when child rows reference nonexistent parent rows — the actual
// Postgres error text ("insert or update on table … violates foreign key
// constraint") doesn't hint at *how many* orphans exist, which is the
// difference between a five-minute fix (a handful) and a data-model
// conversation (millions). See #22.
async function summarizeOrphans(client, collection, field, fkTable, fkColumn) {
    if (!IDENT_RE.test(collection) || !IDENT_RE.test(field))
        return null;
    if (!IDENT_RE.test(fkTable) || !IDENT_RE.test(fkColumn))
        return null;
    const query = `SELECT COUNT(*)::int AS n FROM "${collection}" c ` +
        `LEFT JOIN "${fkTable}" p ON c."${field}" = p."${fkColumn}" ` +
        `WHERE c."${field}" IS NOT NULL AND p."${fkColumn}" IS NULL`;
    try {
        const r = (await client.postRaw("/raw-query/execute", { query }));
        const inner = r?.results?.[0];
        if (!r?.success || !inner?.success)
            return null;
        const n = Number(inner.data?.[0]?.n ?? 0);
        if (n <= 0)
            return null;
        return ` — likely cause: ${n} orphan row(s) in ${collection}.${field} reference ${fkTable}.${fkColumn} that don't exist`;
    }
    catch {
        return null;
    }
}
export async function reconcileRelations(input) {
    const results = [];
    const rejectedNonPublic = [];
    // Load pg_constraint FK state up front — needed for FK-drift detection
    // because Directus's GET /relations `.schema` block reads from a cached
    // SchemaOverview that isn't invalidated by raw ALTER TABLE. Only
    // information_schema.table_constraints is authoritative. (Empirically
    // verified against test.lola.market on 2026-07-18 for issue #16.)
    const tablesToQuery = [];
    let expectedFkCount = 0;
    for (const [collection, relations] of input.relationsByCollection) {
        if (input.opts.onlyCollections && !input.opts.onlyCollections.has(collection))
            continue;
        for (const r of relations) {
            const schema = r.schema;
            if (schema?.foreign_key_table === undefined)
                continue;
            // #20: reject non-public schemas explicitly. Silent misbuild is worse
            // than a loud skip.
            const fkSchema = schema.foreign_key_schema;
            if (fkSchema !== undefined && fkSchema !== null && String(fkSchema) !== "public") {
                rejectedNonPublic.push(`${collection}.${String(r.field)}`);
                continue;
            }
            expectedFkCount++;
            if (!tablesToQuery.includes(collection))
                tablesToQuery.push(collection);
        }
    }
    const pgFks = await loadFkConstraints(input.client, tablesToQuery);
    // #19: warn once when the check was expected to run but /raw-query/execute
    // is unavailable. Without this, silent-skip masks real drift on envs that
    // lack the extension.
    if (pgFks === null && expectedFkCount > 0) {
        process.stderr.write(`relations: could not query information_schema.table_constraints ` +
            `(raw-query endpoint unavailable?) — FK drift check skipped for ` +
            `${expectedFkCount} relation(s)\n`);
    }
    for (const label of rejectedNonPublic) {
        results.push({
            kind: "relations",
            label: `relations/${label}`,
            action: "skipped",
            reason: "non-public foreign_key_schema not supported by FK reconciler",
        });
    }
    for (const [collection, relations] of input.relationsByCollection) {
        if (input.opts.onlyCollections && !input.opts.onlyCollections.has(collection))
            continue;
        for (const desired of relations) {
            const field = String(desired.field ?? "");
            if (!field)
                continue;
            const label = `relations/${collection}.${field}`;
            // Skip anything we already rejected as non-public — the note is already
            // in results and we don't want to double-count.
            if (rejectedNonPublic.includes(`${collection}.${field}`))
                continue;
            let existing;
            try {
                const got = await input.client.get(`/relations/${collection}/${field}`);
                existing = Array.isArray(got) ? null : got;
            }
            catch (e) {
                results.push({ kind: "relations", label, action: "failed", reason: e.message });
                continue;
            }
            const payload = sanitizeForWrite(desired);
            const desiredMeta = payload.meta ?? {};
            const existingMeta = existing?.meta ?? {};
            const desiredSchema = payload.schema;
            // #18: FK drift by COLUMN (not constraint_name). Snapshot says "FK on
            // this column pointing to <table>.<column>"; pg either has that or
            // doesn't. constraint_name is cosmetic — a matching FK under a legacy
            // name is not drift.
            let fkDrift = false;
            let fkDriftMismatch;
            if (existing !== null && pgFks && desiredSchema?.foreign_key_table) {
                const expectedTable = String(desiredSchema.foreign_key_table);
                const expectedColumn = String(desiredSchema.foreign_key_column ?? "id");
                const actual = pgFks.get(collection)?.get(field);
                if (!actual) {
                    fkDrift = true;
                }
                else if (actual.referenced_table !== expectedTable ||
                    actual.referenced_column !== expectedColumn) {
                    // Rare: FK exists on this column but points at the wrong target.
                    // Don't try to auto-repair — a DROP + ADD could break referential
                    // guarantees. Fail loudly and let a human decide.
                    fkDrift = false;
                    fkDriftMismatch = `FK on ${collection}.${field} points to ${actual.referenced_table}.${actual.referenced_column} (snapshot expects ${expectedTable}.${expectedColumn}) — manual DROP+ADD required`;
                }
            }
            if (existing === null) {
                if (!input.opts.dryRun) {
                    try {
                        await input.client.post("/relations", payload);
                    }
                    catch (e) {
                        results.push({ kind: "relations", label, action: "failed", reason: e.message });
                        continue;
                    }
                }
                results.push({ kind: "relations", label, action: "created" });
            }
            else if (fkDriftMismatch) {
                results.push({ kind: "relations", label, action: "failed", reason: fkDriftMismatch });
            }
            else if (fkDrift) {
                if (!input.opts.dryRun) {
                    try {
                        const sql = buildAddConstraintSql({
                            collection,
                            field,
                            schema: desiredSchema,
                        });
                        const r = (await input.client.postRaw("/raw-query/execute", { query: sql }));
                        const inner = r?.results?.[0];
                        if (!r?.success || !inner?.success) {
                            const baseReason = inner?.error ?? "raw-query rejected ALTER TABLE";
                            // #22: orphans are the common cause of ADD CONSTRAINT failing
                            // ("violates foreign key constraint" without a count). Try to
                            // enrich the failure with a specific number.
                            const orphanNote = await summarizeOrphans(input.client, collection, field, String(desiredSchema.foreign_key_table), String(desiredSchema.foreign_key_column ?? "id"));
                            results.push({
                                kind: "relations",
                                label,
                                action: "failed",
                                reason: `${baseReason}${orphanNote ?? ""}`,
                            });
                            continue;
                        }
                    }
                    catch (e) {
                        results.push({ kind: "relations", label, action: "failed", reason: e.message });
                        continue;
                    }
                }
                results.push({
                    kind: "relations",
                    label,
                    action: "updated",
                    reason: "FK constraint missing in Postgres — recreated via ALTER TABLE ADD CONSTRAINT",
                });
            }
            else {
                const dp = diffSubset(desiredMeta, existingMeta);
                if (dp) {
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
                        }
                        catch (e) {
                            results.push({ kind: "relations", label, action: "failed", reason: e.message });
                            continue;
                        }
                    }
                    results.push({
                        kind: "relations",
                        label,
                        action: "updated",
                        reason: `meta.${formatDiffPath(dp)}`,
                    });
                }
                else {
                    results.push({ kind: "relations", label, action: "unchanged" });
                }
            }
        }
    }
    return results;
}
//# sourceMappingURL=relations.js.map