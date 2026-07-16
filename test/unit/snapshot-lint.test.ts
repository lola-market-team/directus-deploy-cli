import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintSnapshot } from "../../src/snapshot-lint.js";

async function scratchRepo(files: Record<string, string>): Promise<{
  root: string;
  snapshotDir: string;
  migrationsDir: string;
  registerDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "snap-"));
  const snapshotDir = join(root, "directus_config", "snapshot");
  const migrationsDir = join(root, "migrations");
  const registerDir = join(migrationsDir, "register");
  await mkdir(join(snapshotDir, "collections"), { recursive: true });
  await mkdir(join(snapshotDir, "fields"), { recursive: true });
  await mkdir(registerDir, { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return { root, snapshotDir, migrationsDir, registerDir };
}

describe("lintSnapshot", () => {
  it("passes when everything resolves", async () => {
    const d = await scratchRepo({
      "directus_config/snapshot/collections/rentals.json": JSON.stringify({
        collection: "rentals",
        schema: { name: "rentals" },
        meta: {},
      }),
      "directus_config/snapshot/fields/rentals/id.json": JSON.stringify({
        collection: "rentals",
        field: "id",
        type: "uuid",
      }),
    });
    const r = await lintSnapshot(d);
    expect(r.offenders).toEqual([]);
    expect(r.collectionsScanned).toBe(1);
  });

  it("flags meta.group refs that don't resolve", async () => {
    const d = await scratchRepo({
      "directus_config/snapshot/collections/thing.json": JSON.stringify({
        collection: "thing",
        meta: { group: "not_a_real_collection" },
      }),
    });
    const r = await lintSnapshot(d);
    expect(r.offenders).toHaveLength(1);
    expect(r.offenders[0]!.message).toMatch(/no such collection/);
  });

  it("flags field FK targets that don't resolve", async () => {
    const d = await scratchRepo({
      "directus_config/snapshot/collections/thing.json": JSON.stringify({
        collection: "thing",
        schema: {},
      }),
      "directus_config/snapshot/fields/thing/parent.json": JSON.stringify({
        collection: "thing",
        field: "parent",
        schema: { foreign_key_table: "nowhere" },
      }),
    });
    const r = await lintSnapshot(d);
    // "thing" is missing its own fields entry too — but we set one above, so
    // only the FK check fires.
    expect(r.offenders.some((o) => o.message.includes("FK → nowhere"))).toBe(true);
  });

  it("ignores directus_* system-collection FKs", async () => {
    const d = await scratchRepo({
      "directus_config/snapshot/collections/thing.json": JSON.stringify({
        collection: "thing",
        schema: {},
      }),
      "directus_config/snapshot/fields/thing/owner.json": JSON.stringify({
        collection: "thing",
        field: "owner",
        schema: { foreign_key_table: "directus_users" },
      }),
    });
    const r = await lintSnapshot(d);
    expect(r.offenders).toEqual([]);
  });

  it("flags a register manifest without a matching snapshot collection", async () => {
    const d = await scratchRepo({
      "migrations/register/orphan.json": JSON.stringify({ table: "orphan" }),
    });
    const r = await lintSnapshot(d);
    expect(r.offenders.some((o) => o.message.includes("no snapshot/collections"))).toBe(true);
  });

  it("flags a register manifest whose fields dir is empty", async () => {
    const d = await scratchRepo({
      "migrations/register/present.json": JSON.stringify({ table: "present" }),
      "directus_config/snapshot/collections/present.json": JSON.stringify({
        collection: "present",
        schema: {},
      }),
    });
    const r = await lintSnapshot(d);
    expect(r.offenders.some((o) => o.message.includes("empty or missing"))).toBe(true);
  });

  it("flags data collections missing a fields dir (owner_earnings drift shape)", async () => {
    const d = await scratchRepo({
      "directus_config/snapshot/collections/owner_earnings.json": JSON.stringify({
        collection: "owner_earnings",
        schema: { name: "owner_earnings" },
      }),
    });
    const r = await lintSnapshot(d);
    expect(r.offenders.some((o) => o.message.includes("owner_earnings"))).toBe(true);
  });

  it("flags '-- ...;' comment lines in migration files", async () => {
    const d = await scratchRepo({
      "migrations/001.sql": "-- run this; then that\nCREATE INDEX x ON t (a);",
    });
    const r = await lintSnapshot(d);
    expect(r.offenders.some((o) => o.file.endsWith(":1") && o.message.includes("raw-query"))).toBe(true);
  });
});
