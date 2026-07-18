import { describe, expect, it, vi } from "vitest";
import { reconcileCollections } from "../../src/reconcilers/collections.js";
import { reconcileFields } from "../../src/reconcilers/fields.js";
import { reconcileRelations } from "../../src/reconcilers/relations.js";
import type { DirectusClient } from "../../src/types.js";

function mockClient(overrides: Partial<DirectusClient> = {}): DirectusClient {
  return {
    get: vi.fn(async () => null),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    postRaw: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe("reconcileCollections", () => {
  it("creates when missing", async () => {
    const client = mockClient();
    const results = await reconcileCollections({
      collections: [{ collection: "listings", meta: { hidden: false } }],
      registerManifests: new Set(),
      client,
      opts: { dryRun: false },
    });
    expect(results).toEqual([{ kind: "collections", label: "collections/listings", action: "created" }]);
    expect(client.post).toHaveBeenCalledWith("/collections", { collection: "listings", meta: { hidden: false } });
  });

  it("skips register-manifest collections", async () => {
    const client = mockClient();
    const results = await reconcileCollections({
      collections: [{ collection: "owner_earnings", meta: {} }],
      registerManifests: new Set(["owner_earnings"]),
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("skipped");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("dry-run doesn't write", async () => {
    const client = mockClient();
    await reconcileCollections({
      collections: [{ collection: "listings", meta: { hidden: false } }],
      registerManifests: new Set(),
      client,
      opts: { dryRun: true },
    });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("PATCHes only meta on drift", async () => {
    const client = mockClient({
      get: vi.fn(async () => ({ collection: "listings", meta: { hidden: false } })),
    });
    await reconcileCollections({
      collections: [{ collection: "listings", meta: { hidden: true } }],
      registerManifests: new Set(),
      client,
      opts: { dryRun: false },
    });
    expect(client.patch).toHaveBeenCalledWith("/collections/listings", { meta: { hidden: true } });
  });

  it("inlines snapshot fields at CREATE so Directus provisions the intended PK", async () => {
    const client = mockClient();
    const fields = new Map<string, Record<string, unknown>[]>();
    fields.set("sale_gift_transactions", [
      {
        collection: "sale_gift_transactions",
        field: "id",
        type: "uuid",
        meta: { special: ["uuid"], hidden: true },
        schema: { is_primary_key: true, has_auto_increment: false, default_value: "gen_random_uuid()" },
      },
      {
        collection: "sale_gift_transactions",
        field: "kind",
        type: "string",
        meta: { interface: "select-dropdown" },
        schema: { is_nullable: false },
      },
    ]);
    await reconcileCollections({
      collections: [{ collection: "sale_gift_transactions", meta: { hidden: false } }],
      registerManifests: new Set(),
      fieldsByCollection: fields,
      client,
      opts: { dryRun: false },
    });
    const posted = (client.post as ReturnType<typeof vi.fn>).mock.calls[0]![1] as {
      fields: Record<string, unknown>[];
    };
    expect(Array.isArray(posted.fields)).toBe(true);
    expect(posted.fields).toHaveLength(2);
    const idField = posted.fields.find((f) => (f as { field: string }).field === "id")!;
    expect((idField as { type: string }).type).toBe("uuid");
    expect((idField as { collection?: string }).collection).toBeUndefined();
  });

  it("falls back to bare payload when no fields snapshot is provided", async () => {
    const client = mockClient();
    await reconcileCollections({
      collections: [{ collection: "listings", meta: { hidden: false } }],
      registerManifests: new Set(),
      client,
      opts: { dryRun: false },
    });
    expect(client.post).toHaveBeenCalledWith("/collections", { collection: "listings", meta: { hidden: false } });
  });

  it("only-collections filter", async () => {
    const client = mockClient();
    const results = await reconcileCollections({
      collections: [
        { collection: "listings", meta: {} },
        { collection: "rentals", meta: {} },
      ],
      registerManifests: new Set(),
      client,
      opts: { dryRun: false, onlyCollections: new Set(["rentals"]) },
    });
    expect(results.map((r) => r.label)).toEqual(["collections/rentals"]);
  });
});

describe("reconcileFields", () => {
  it("skips unregistered raw-SQL columns", async () => {
    const client = mockClient({
      get: vi.fn(async () => ({ type: "unknown", meta: null })),
    });
    const fields = new Map<string, Record<string, unknown>[]>();
    fields.set("categories", [{ collection: "categories", field: "embedding", type: "unknown", meta: null }]);
    const results = await reconcileFields({
      fieldsByCollection: fields,
      registerManifests: new Set(),
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("skipped");
    expect(results[0]!.reason).toMatch(/unregistered raw-SQL column/);
  });

  it("omits schema on PATCH when schema matches", async () => {
    const client = mockClient({
      get: vi.fn(async () => ({
        collection: "x",
        field: "y",
        type: "string",
        meta: { hidden: false },
        schema: { data_type: "text" },
      })),
    });
    const fields = new Map<string, Record<string, unknown>[]>();
    fields.set("x", [
      {
        collection: "x",
        field: "y",
        type: "string",
        meta: { hidden: true },
        schema: { data_type: "text" },
      },
    ]);
    await reconcileFields({
      fieldsByCollection: fields,
      registerManifests: new Set(),
      client,
      opts: { dryRun: false },
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/fields/x/y",
      expect.objectContaining({ meta: { hidden: true } }),
    );
    const patched = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(patched.schema).toBeUndefined();
  });

  it("includes schema on PATCH when schema differs", async () => {
    const client = mockClient({
      get: vi.fn(async () => ({
        collection: "x",
        field: "y",
        type: "string",
        meta: { hidden: false },
        schema: { data_type: "text", is_nullable: true },
      })),
    });
    const fields = new Map<string, Record<string, unknown>[]>();
    fields.set("x", [
      {
        collection: "x",
        field: "y",
        type: "string",
        meta: { hidden: false },
        schema: { data_type: "text", is_nullable: false },
      },
    ]);
    await reconcileFields({
      fieldsByCollection: fields,
      registerManifests: new Set(),
      client,
      opts: { dryRun: false },
    });
    const patched = (client.patch as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(patched.schema).toEqual({ data_type: "text", is_nullable: false });
  });

  it("ignores foreign_key_* triplet in schema diff (owned by /relations — issue #16)", async () => {
    // Desired snapshot declares the FK; live target has no FK constraint
    // (foreign_key_* keys absent). Fields reconciler used to keep firing
    // UPDATED forever because PATCH /fields doesn't create the FK. Now it
    // strips those keys and reports unchanged.
    const client = mockClient({
      get: vi.fn(async () => ({
        collection: "sale_gift_transactions",
        field: "user_created",
        type: "uuid",
        meta: { hidden: true },
        schema: { data_type: "uuid", is_nullable: false },
      })),
    });
    const fields = new Map<string, Record<string, unknown>[]>();
    fields.set("sale_gift_transactions", [
      {
        collection: "sale_gift_transactions",
        field: "user_created",
        type: "uuid",
        meta: { hidden: true },
        schema: {
          data_type: "uuid",
          is_nullable: false,
          foreign_key_column: "id",
          foreign_key_schema: "public",
          foreign_key_table: "directus_users",
        },
      },
    ]);
    const results = await reconcileFields({
      fieldsByCollection: fields,
      registerManifests: new Set(),
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("unchanged");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("skips entire collection when register-manifest exists", async () => {
    const client = mockClient();
    const fields = new Map<string, Record<string, unknown>[]>();
    fields.set("owner_earnings", [{ field: "id" }]);
    const results = await reconcileFields({
      fieldsByCollection: fields,
      registerManifests: new Set(["owner_earnings"]),
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("skipped");
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe("reconcileRelations", () => {
  it("creates when missing", async () => {
    const client = mockClient();
    const rels = new Map<string, Record<string, unknown>[]>();
    rels.set("listings", [{ collection: "listings", field: "category_id", meta: { junction_field: null } }]);
    const results = await reconcileRelations({
      relationsByCollection: rels,
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("created");
    expect(client.post).toHaveBeenCalledWith("/relations", expect.any(Object));
  });

  it("emits ALTER TABLE ADD CONSTRAINT when pg_constraint missing the FK (issue #16)", async () => {
    // Row present in directus_relations, GET /relations even returns a cached
    // schema block, but information_schema.table_constraints has no matching
    // FK — that's the state the user hits in the wild (verified against
    // test.lola.market 2026-07-18). Repair path: raw ALTER TABLE, not
    // DELETE+POST (Directus's cached SchemaOverview would skip re-creation).
    const rawQueryCalls: Array<{ path: string; body: unknown }> = [];
    const client = mockClient({
      get: vi.fn(async () => ({
        collection: "sale_gift_transactions",
        field: "user_created",
        meta: {
          many_collection: "sale_gift_transactions",
          many_field: "user_created",
          one_collection: "directus_users",
        },
        schema: {
          // Directus reports the FK present from its cached SchemaOverview
          // even though pg_constraint has it dropped.
          constraint_name: "sale_gift_transactions_user_created_foreign",
          foreign_key_table: "directus_users",
          foreign_key_column: "id",
        },
      })),
      postRaw: vi.fn(async (path: string, body: unknown) => {
        rawQueryCalls.push({ path, body });
        const query = (body as { query: string }).query;
        // First call is the FK-loading SELECT; return "no FK for user_created".
        if (query.includes("information_schema.table_constraints")) {
          return {
            success: true,
            results: [{ success: true, data: [] }],
          };
        }
        // Second call is the ALTER TABLE — accept it.
        return { success: true, results: [{ success: true, data: [], rowCount: 0 }] };
      }),
    });
    const rels = new Map<string, Record<string, unknown>[]>();
    rels.set("sale_gift_transactions", [
      {
        collection: "sale_gift_transactions",
        field: "user_created",
        meta: {
          many_collection: "sale_gift_transactions",
          many_field: "user_created",
          one_collection: "directus_users",
        },
        schema: {
          constraint_name: "sale_gift_transactions_user_created_foreign",
          foreign_key_table: "directus_users",
          foreign_key_column: "id",
          on_delete: "NO ACTION",
          on_update: "NO ACTION",
        },
      },
    ]);
    const results = await reconcileRelations({
      relationsByCollection: rels,
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("updated");
    expect(results[0]!.reason).toMatch(/ALTER TABLE ADD CONSTRAINT/);
    expect(rawQueryCalls).toHaveLength(2);
    expect((rawQueryCalls[1]!.body as { query: string }).query).toMatch(
      /ALTER TABLE "sale_gift_transactions" ADD CONSTRAINT "sale_gift_transactions_user_created_foreign"/,
    );
    expect((rawQueryCalls[1]!.body as { query: string }).query).toMatch(
      /FOREIGN KEY \("user_created"\) REFERENCES "directus_users"\("id"\)/,
    );
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("marks unchanged when pg_constraint reports the expected FK present", async () => {
    const client = mockClient({
      get: vi.fn(async () => ({
        collection: "sale_gift_transactions",
        field: "user_created",
        meta: {
          many_collection: "sale_gift_transactions",
          many_field: "user_created",
          one_collection: "directus_users",
        },
        schema: {
          constraint_name: "sale_gift_transactions_user_created_foreign",
          foreign_key_table: "directus_users",
          foreign_key_column: "id",
        },
      })),
      postRaw: vi.fn(async () => ({
        success: true,
        results: [{
          success: true,
          data: [{
            table_name: "sale_gift_transactions",
            constraint_name: "sale_gift_transactions_user_created_foreign",
          }],
        }],
      })),
    });
    const rels = new Map<string, Record<string, unknown>[]>();
    rels.set("sale_gift_transactions", [
      {
        collection: "sale_gift_transactions",
        field: "user_created",
        meta: {
          many_collection: "sale_gift_transactions",
          many_field: "user_created",
          one_collection: "directus_users",
        },
        schema: {
          constraint_name: "sale_gift_transactions_user_created_foreign",
          foreign_key_table: "directus_users",
          foreign_key_column: "id",
        },
      },
    ]);
    const results = await reconcileRelations({
      relationsByCollection: rels,
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("unchanged");
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("skips FK-drift check gracefully when /raw-query/execute unavailable", async () => {
    // Some targets don't have the raw-query extension. FK repair silently
    // no-ops rather than failing — same behavior as fetchUnknownFields.
    const client = mockClient({
      get: vi.fn(async () => ({
        collection: "x",
        field: "y",
        meta: { many_collection: "x", many_field: "y", one_collection: "z" },
        schema: { foreign_key_table: "z", foreign_key_column: "id" },
      })),
      postRaw: vi.fn(async () => {
        throw new Error("404 not found");
      }),
    });
    const rels = new Map<string, Record<string, unknown>[]>();
    rels.set("x", [
      {
        collection: "x",
        field: "y",
        meta: { many_collection: "x", many_field: "y", one_collection: "z" },
        schema: { foreign_key_table: "z", foreign_key_column: "id" },
      },
    ]);
    const results = await reconcileRelations({
      relationsByCollection: rels,
      client,
      opts: { dryRun: false },
    });
    // Skipped FK check ⇒ treat as unchanged. Not perfect, but the old
    // behavior — false-positive drift loop is avoided by fields FK-stripping.
    expect(results[0]!.action).toBe("unchanged");
  });

  it("FK-drift path is a no-op under dryRun", async () => {
    const client = mockClient({
      get: vi.fn(async () => ({
        collection: "x",
        field: "y",
        meta: { many_collection: "x", many_field: "y", one_collection: "z" },
        schema: {
          constraint_name: "x_y_foreign",
          foreign_key_table: "z",
          foreign_key_column: "id",
        },
      })),
      postRaw: vi.fn(async () => ({ success: true, results: [{ success: true, data: [] }] })),
    });
    const rels = new Map<string, Record<string, unknown>[]>();
    rels.set("x", [
      {
        collection: "x",
        field: "y",
        meta: { many_collection: "x", many_field: "y", one_collection: "z" },
        schema: {
          constraint_name: "x_y_foreign",
          foreign_key_table: "z",
          foreign_key_column: "id",
        },
      },
    ]);
    const results = await reconcileRelations({
      relationsByCollection: rels,
      client,
      opts: { dryRun: true },
    });
    expect(results[0]!.action).toBe("updated");
    // Only the loadFkConstraints SELECT — not the ALTER TABLE.
    const calls = (client.postRaw as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(1);
    expect((calls[0]![1] as { query: string }).query).toMatch(/table_constraints/);
  });

  it("tolerates meta: null", async () => {
    const client = mockClient({
      get: vi.fn(async () => ({ collection: "x", field: "y", meta: null })),
    });
    const rels = new Map<string, Record<string, unknown>[]>();
    rels.set("x", [{ collection: "x", field: "y", meta: null }]);
    const results = await reconcileRelations({
      relationsByCollection: rels,
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("unchanged");
  });
});
