import { diffSubset, formatDiffPath } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
const FK_SCHEMA_KEYS = new Set([
    "foreign_key_column",
    "foreign_key_schema",
    "foreign_key_table",
    "constraint_name",
]);
function stripFkKeys(schema) {
    if (!schema)
        return schema;
    const out = {};
    for (const [k, v] of Object.entries(schema)) {
        if (FK_SCHEMA_KEYS.has(k))
            continue;
        out[k] = v;
    }
    return out;
}
// A definition the register reconciler can never create. It sources its work
// from information_schema.columns, so anything without a column on a fresh
// target is permanently outside its reach. Two shapes qualify:
//
//   schema === null          — alias fields: o2m/m2m, presentation. These
//                              genuinely never get a column.
//   special includes no-data — computed fields an extension hydrates at read
//                              time. These DO get a real column (see below),
//                              but only as a side effect of the POST that
//                              creates the field — so until someone applies
//                              the definition, register has nothing to find.
//
// Measured against a live Directus on 2026-08-28, POST /fields/rentals:
//   type=integer, special=[no-data], schema=null  -> column CREATED, and the
//                                                    field is selectable
//   type=alias,   special=[no-data], schema=null  -> no column, and the field
//                                                    403s on select
// Directus derives the column from `type`; schema absent, null, or populated
// all create one. Only an alias type avoids it, and an alias cannot be read
// back. So a computed field IS a real nullable column that a read hook
// overwrites on the way out — do not "fix" that by stripping schema, which
// only makes the column's attributes drift from the snapshot.
function isRegisterInvisible(desired) {
    if (desired["schema"] === null)
        return true;
    const meta = desired["meta"];
    const special = meta?.["special"];
    return Array.isArray(special) && special.includes("no-data");
}
export async function reconcileFields(input) {
    const results = [];
    for (const [collection, fields] of input.fieldsByCollection) {
        if (input.opts.onlyCollections && !input.opts.onlyCollections.has(collection))
            continue;
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
        let deferred = [];
        if (adopted) {
            pending = fields.filter(isRegisterInvisible);
            deferred = fields
                .filter((f) => !isRegisterInvisible(f))
                .map((f) => String(f.field ?? ""))
                .filter(Boolean);
            if (deferred.length > 0) {
                results.push({
                    kind: "fields",
                    label: `fields/${collection}/*`,
                    action: "skipped",
                    reason: `raw-SQL adopted — ${deferred.length} column-backed field(s) owned by register-table`,
                });
            }
        }
        for (const desired of pending) {
            const field = String(desired.field ?? "");
            if (!field)
                continue;
            const label = `fields/${collection}.${field}`;
            let existing;
            try {
                const got = await input.client.get(`/fields/${collection}/${field}`);
                existing = Array.isArray(got) ? null : got;
            }
            catch (e) {
                results.push({ kind: "fields", label, action: "failed", reason: e.message });
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
            const payload = sanitizeForWrite(desired);
            const desiredMeta = payload.meta ?? {};
            // Alias fields carry `schema: null` in the snapshot already; nothing to
            // force. Computed (no-data) fields keep their schema block — it
            // describes the column Directus creates for them either way, and
            // sending it keeps that column matching the snapshot instead of
            // Directus's defaults.
            // Only send schema when it *actually* differs. Re-asserting unchanged
            // schema on PK / sequence-backed columns makes Directus emit
            // ALTER COLUMN … DROP NOT NULL which Postgres rejects (verified today).
            // FK-triplet keys (foreign_key_*, constraint_name) are owned by
            // /relations, not /fields — PATCHing /fields with them is a no-op that
            // still reports UPDATED, causing perpetual drift. Strip them so the
            // fields diff ignores FK state entirely.
            const desiredSchema = stripFkKeys(payload.schema);
            const existingSchema = stripFkKeys(existing?.schema) ?? {};
            const desiredShape = {
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
                    }
                    catch (e) {
                        results.push({ kind: "fields", label, action: "failed", reason: e.message });
                        continue;
                    }
                }
                results.push({ kind: "fields", label, action: "created" });
            }
            else {
                const dp = diffSubset(desiredShape, existing);
                if (dp) {
                    if (!input.opts.dryRun) {
                        try {
                            await input.client.patch(`/fields/${collection}/${field}`, desiredShape);
                        }
                        catch (e) {
                            results.push({ kind: "fields", label, action: "failed", reason: e.message });
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
                }
                else {
                    results.push({ kind: "fields", label, action: "unchanged" });
                }
            }
        }
        // Receipt for the fields handed to the register reconciler.
        //
        // The handoff above has no natural feedback: the two sides enumerate
        // different universes — git holds field DEFINITIONS, register walks
        // Postgres COLUMNS — and a `skipped` line is not drift, so a definition
        // owned by nobody reads as success on every plan, verify and apply. That
        // is precisely how prod ran seven weeks without the four computed
        // `rentals` fields while their JSON sat in git the whole time.
        //
        // So assert the delegation was honoured: everything deferred must exist
        // on the target once register has run. Only the deferred set is checked —
        // fields this reconciler applies itself report their own outcome, and in
        // a dry run they legitimately do not exist yet.
        if (deferred.length > 0) {
            const label = `fields/${collection} (registration receipt)`;
            let rows;
            try {
                rows = await input.client.get(`/fields/${collection}`);
            }
            catch (e) {
                results.push({ kind: "fields", label, action: "failed", reason: e.message });
                continue;
            }
            const present = new Set((Array.isArray(rows) ? rows : [])
                .map((r) => String(r?.field ?? ""))
                .filter(Boolean));
            const missing = deferred.filter((f) => !present.has(f));
            if (missing.length > 0) {
                results.push({
                    kind: "fields",
                    label,
                    action: "failed",
                    reason: `defined in the snapshot but not registered on the target: ${missing.join(", ")}. ` +
                        `This collection has a register manifest, so the fields reconciler defers ` +
                        `column-backed fields to register — but register only walks real Postgres ` +
                        `columns. A definition with no column is claimed by nobody. Add the migration ` +
                        `that creates the column, or make the definition column-less (schema: null for ` +
                        `an alias, special: ["no-data"] for a computed field); do not leave it unowned.`,
                });
            }
        }
    }
    return results;
}
//# sourceMappingURL=fields.js.map