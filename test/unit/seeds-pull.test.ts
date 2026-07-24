import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullSeed } from "../../src/seeds-pull.js";
import type { DirectusClient } from "../../src/types.js";

function mockClient(rows: Record<string, unknown>[]): DirectusClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/fields/")) {
        return [{ field: "id", schema: { is_primary_key: true } }];
      }
      return rows;
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    postRaw: vi.fn(async () => ({})),
  };
}

describe("seeds pull (#37)", () => {
  it("writes a new seed file with default meta, topo-ordered parents first", async () => {
    const seedDir = await mkdtemp(join(tmpdir(), "seedpull-"));
    // child (id 1) has parent 9 — must sort after it despite lower id
    const client = mockClient([
      { id: 1, parent_id: 9, code: "7.1", title: "Child" },
      { id: 9, parent_id: null, code: "7", title: "Root" },
    ]);
    const res = await pullSeed({
      client,
      seedDir,
      collection: "categories",
      fields: ["id", "parent_id", "code", "title"],
    });
    expect(res.rows).toBe(2);
    const body = JSON.parse(await readFile(join(seedDir, "categories.json"), "utf8"));
    expect(body.meta).toEqual({
      insert_order: 50, preserve_ids: true, create: true, update: true, delete: false,
    });
    expect(body.data.map((r: { id: number }) => r.id)).toEqual([9, 1]);
  });

  it("preserves existing meta and derives fields from the existing file", async () => {
    const seedDir = await mkdtemp(join(tmpdir(), "seedpull-"));
    await writeFile(
      join(seedDir, "categories.json"),
      JSON.stringify({
        collection: "categories",
        meta: { insert_order: 77, preserve_ids: true, create: true, update: false, delete: false },
        data: [{ id: 9, code: "7", title: "Old" }],
      }),
      "utf8",
    );
    const client = mockClient([{ id: 9, code: "7", title: "New" }]);
    const res = await pullSeed({ client, seedDir, collection: "categories" });
    expect(res.fields.sort()).toEqual(["code", "id", "title"]);
    const body = JSON.parse(await readFile(join(seedDir, "categories.json"), "utf8"));
    expect(body.meta.insert_order).toBe(77);
    expect(body.meta.update).toBe(false);
    expect(body.data).toEqual([{ id: 9, code: "7", title: "New" }]);
  });

  it("fails on duplicate PKs (preserve_ids contract)", async () => {
    const seedDir = await mkdtemp(join(tmpdir(), "seedpull-"));
    const client = mockClient([{ id: 1, code: "a" }, { id: 1, code: "b" }]);
    await expect(
      pullSeed({ client, seedDir, collection: "categories", fields: ["id", "code"] }),
    ).rejects.toThrow(/duplicate id=1/);
  });

  it("fails a first pull without --fields", async () => {
    const seedDir = await mkdtemp(join(tmpdir(), "seedpull-"));
    const client = mockClient([]);
    await expect(pullSeed({ client, seedDir, collection: "nope" })).rejects.toThrow(/no --fields/);
  });
});
