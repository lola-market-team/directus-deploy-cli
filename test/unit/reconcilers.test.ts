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
