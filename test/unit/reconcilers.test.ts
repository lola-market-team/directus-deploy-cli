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

  it("recreates FK via DELETE+POST when schema is missing on target (issue #16)", async () => {
    // Row present in directus_relations, but Postgres FK dropped — schema comes
    // back null from information_schema. Repair path: DELETE then POST.
    const client = mockClient({
      get: vi.fn(async () => ({
        collection: "sale_gift_transactions",
        field: "user_created",
        meta: {
          many_collection: "sale_gift_transactions",
          many_field: "user_created",
          one_collection: "directus_users",
        },
        schema: null,
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
    expect(results[0]!.reason).toMatch(/recreated/i);
    expect(client.delete).toHaveBeenCalledWith(
      "/relations/sale_gift_transactions/user_created",
    );
    expect(client.post).toHaveBeenCalledWith("/relations", expect.any(Object));
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("does NOT touch anything when FK schema matches (subset-based diff)", async () => {
    // GET returns extra server-only keys (column, table, constraint_name) that
    // must NOT trigger a diff — we only compare the FK-defining subset.
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
          column: "user_created",
          constraint_name: "sale_gift_transactions_user_created_foreign",
          foreign_key_table: "directus_users",
          foreign_key_column: "id",
          foreign_key_schema: "public",
          on_delete: "NO ACTION",
          on_update: "NO ACTION",
          table: "sale_gift_transactions",
        },
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
          foreign_key_table: "directus_users",
          foreign_key_column: "id",
          foreign_key_schema: "public",
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
    expect(results[0]!.action).toBe("unchanged");
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("FK-drift path is a no-op under dryRun", async () => {
    const client = mockClient({
      get: vi.fn(async () => ({
        collection: "x",
        field: "y",
        meta: {},
        schema: null,
      })),
    });
    const rels = new Map<string, Record<string, unknown>[]>();
    rels.set("x", [
      {
        collection: "x",
        field: "y",
        meta: {},
        schema: { foreign_key_table: "z", foreign_key_column: "id" },
      },
    ]);
    const results = await reconcileRelations({
      relationsByCollection: rels,
      client,
      opts: { dryRun: true },
    });
    expect(results[0]!.action).toBe("updated");
    expect(client.delete).not.toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
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
