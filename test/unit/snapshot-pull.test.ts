import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullSnapshot } from "../../src/snapshot-pull.js";
import type { DirectusClient } from "../../src/types.js";

async function scratchSnapshot(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "snap-pull-"));
  const snapshotDir = join(root, "snapshot");
  await mkdir(join(snapshotDir, "collections"), { recursive: true });
  await mkdir(join(snapshotDir, "fields"), { recursive: true });
  await mkdir(join(snapshotDir, "relations"), { recursive: true });
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, "snapshot", rel);
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return snapshotDir;
}

function mkClient(routes: Record<string, unknown>): DirectusClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path in routes) return routes[path] as Record<string, unknown>[];
      const err = new Error(`403 ${path} :: not found`);
      throw err;
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    postRaw: vi.fn(async () => ({})),
  };
}

describe("pullSnapshot", () => {
  it("auto-detects drift and writes fields + relations", async () => {
    const snapshotDir = await scratchSnapshot({
      "collections/rentals.json": JSON.stringify({
        collection: "rentals",
        schema: { name: "rentals" },
      }),
    });
    const client = mkClient({
      "/fields/rentals": [
        { collection: "rentals", field: "id", type: "uuid", meta: { id: 5 } },
        { collection: "rentals", field: "name", type: "string", meta: {} },
      ],
      "/relations/rentals": [],
    });
    const results = await pullSnapshot({ snapshotDir, client });
    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("pulled");
    expect(results[0]!.fieldsWritten).toBe(2);
    // meta.id stripped
    const idJson = JSON.parse(await readFile(join(snapshotDir, "fields", "rentals", "id.json"), "utf8"));
    expect(idJson.meta).toEqual({}); // id removed from meta
    expect(idJson.id).toBeUndefined();
  });

  it("skips type=unknown fields (adopted-but-unregistered raw-SQL columns)", async () => {
    const snapshotDir = await scratchSnapshot({
      "collections/listings.json": JSON.stringify({
        collection: "listings",
        schema: {},
      }),
    });
    const client = mkClient({
      "/fields/listings": [
        { collection: "listings", field: "id", type: "uuid", meta: {} },
        { collection: "listings", field: "embedding", type: "unknown", meta: null },
      ],
      "/relations/listings": [],
    });
    const results = await pullSnapshot({ snapshotDir, client });
    expect(results[0]!.fieldsWritten).toBe(1);
    expect(results[0]!.fieldsSkipped).toBe(1);
    expect(existsSync(join(snapshotDir, "fields", "listings", "embedding.json"))).toBe(false);
  });

  it("drops the snapshot file for phantom collections (target 403s)", async () => {
    const snapshotDir = await scratchSnapshot({
      "collections/ghost.json": JSON.stringify({
        collection: "ghost",
        schema: {},
      }),
    });
    const client = mkClient({}); // no routes = 403 for everything
    const results = await pullSnapshot({ snapshotDir, client });
    expect(results[0]!.action).toBe("phantom");
    expect(existsSync(join(snapshotDir, "collections", "ghost.json"))).toBe(false);
  });

  it("dry-run reports drift without touching disk", async () => {
    const snapshotDir = await scratchSnapshot({
      "collections/rentals.json": JSON.stringify({
        collection: "rentals",
        schema: {},
      }),
    });
    const client = mkClient({
      "/fields/rentals": [
        { collection: "rentals", field: "id", type: "uuid", meta: {} },
      ],
      "/relations/rentals": [],
    });
    const results = await pullSnapshot({ snapshotDir, client, dryRun: true });
    expect(results[0]!.action).toBe("dry-run");
    expect(existsSync(join(snapshotDir, "fields", "rentals"))).toBe(false);
  });

  it("returns empty when no drift is detected", async () => {
    const snapshotDir = await scratchSnapshot({
      "collections/rentals.json": JSON.stringify({
        collection: "rentals",
        schema: {},
      }),
      "fields/rentals/id.json": JSON.stringify({ field: "id" }),
    });
    const client = mkClient({});
    const results = await pullSnapshot({ snapshotDir, client });
    expect(results).toEqual([]);
  });

  it("uses explicit collection args when provided (skips drift detection)", async () => {
    const snapshotDir = await scratchSnapshot({});
    const client = mkClient({
      "/fields/one": [{ collection: "one", field: "id", type: "uuid", meta: {} }],
      "/relations/one": [],
    });
    const results = await pullSnapshot({ snapshotDir, client, targets: ["one"] });
    expect(results[0]!.action).toBe("pulled");
    expect(await readdir(join(snapshotDir, "fields", "one"))).toEqual(["id.json"]);
  });
});
