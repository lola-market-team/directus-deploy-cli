import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcileSeeds } from "../../src/reconcilers/seeds.js";
import type { DirectusClient } from "../../src/types.js";

// A recording DirectusClient. GET answers the two paths the reconciler hits
// (/fields/<c> for PK resolution, /items/<c> for the server rows); writes are
// captured so a test can assert exactly what the reconciler did.
function mockClient(server: Record<string, unknown>[], pkField = "id") {
  const calls = {
    post: [] as { path: string; body: any }[],
    patch: [] as { path: string; body: any }[],
    delete: [] as { path: string }[],
  };
  const client: DirectusClient = {
    async get(path) {
      if (path.startsWith("/fields/"))
        return [{ field: pkField, schema: { is_primary_key: true } }] as any;
      if (path.startsWith("/items/")) return server as any;
      return null;
    },
    async post(path, body) { calls.post.push({ path, body }); return {}; },
    async patch(path, body) { calls.patch.push({ path, body }); return {}; },
    async delete(path) { calls.delete.push({ path }); },
    async postRaw() { return {}; },
  };
  return { client, calls };
}

const COLL = "categories_translations";
const NAT = ["categories_id", "languages_code"];

describe("reconcileSeeds match_on (natural-key identity)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "seed-matchon-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function writeSeed(data: Record<string, unknown>[], meta: Record<string, unknown> = {}) {
    writeFileSync(
      join(dir, `${COLL}.json`),
      JSON.stringify({ collection: COLL, meta: { insert_order: 1, ...meta }, data }),
    );
  }

  it("id churned but natural key + content identical → no write (matched, unchanged)", async () => {
    writeSeed(
      [{ id: 999, categories_id: 1, languages_code: "en-US", title: "X" }],
      { match_on: NAT },
    );
    const { client, calls } = mockClient([
      { id: 1, categories_id: 1, languages_code: "en-US", title: "X" },
    ]);
    const res = await reconcileSeeds({ seedDir: dir, client, opts: { dryRun: false } });
    expect(calls.post).toHaveLength(0);
    expect(calls.patch).toHaveLength(0);
    expect(res.find((r) => r.action === "unchanged")).toBeTruthy();
  });

  it("content changed, id churned → PATCH by the SERVER pk, payload carries no id", async () => {
    writeSeed(
      [{ id: 999, categories_id: 1, languages_code: "en-US", title: "NEW" }],
      { match_on: NAT },
    );
    const { client, calls } = mockClient([
      { id: 1, categories_id: 1, languages_code: "en-US", title: "OLD" },
    ]);
    await reconcileSeeds({ seedDir: dir, client, opts: { dryRun: false } });
    expect(calls.post).toHaveLength(0);
    expect(calls.patch).toHaveLength(1);
    // PATCHes the row the natural key matched (server id 1), NOT the seed's 999
    expect(calls.patch[0].path).toBe(`/items/${COLL}/1`);
    expect(calls.patch[0].body.title).toBe("NEW");
    expect(calls.patch[0].body).not.toHaveProperty("id"); // id is env-local, never asserted
  });

  it("new natural key → POST without an id", async () => {
    writeSeed(
      [{ id: 5, categories_id: 2, languages_code: "de-DE", title: "Neu" }],
      { match_on: NAT },
    );
    const { client, calls } = mockClient([]);
    await reconcileSeeds({ seedDir: dir, client, opts: { dryRun: false } });
    expect(calls.patch).toHaveLength(0);
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].body).not.toHaveProperty("id");
    expect(calls.post[0].body).toMatchObject({ categories_id: 2, languages_code: "de-DE" });
  });

  it("extras are computed by natural key and pruned by pk", async () => {
    writeSeed(
      [{ categories_id: 1, languages_code: "en-US", title: "X" }],
      { match_on: NAT, delete: true },
    );
    const { client, calls } = mockClient([
      { id: 1, categories_id: 1, languages_code: "en-US", title: "X" }, // matches seed key
      { id: 2, categories_id: 9, languages_code: "en-US", title: "orphan" }, // key not in seed
    ]);
    await reconcileSeeds({ seedDir: dir, client, opts: { dryRun: false, prune: true } });
    expect(calls.delete).toHaveLength(1);
    expect(calls.delete[0].path).toBe(`/items/${COLL}/2`);
  });

  it("WITHOUT match_on the historical PK behaviour is unchanged (id churn → create)", async () => {
    writeSeed([{ id: 999, categories_id: 1, languages_code: "en-US", title: "X" }]); // no match_on
    const { client, calls } = mockClient([
      { id: 1, categories_id: 1, languages_code: "en-US", title: "X" },
    ]);
    await reconcileSeeds({ seedDir: dir, client, opts: { dryRun: false } });
    // Matched by pk (999 absent) → create; the exact churn the natural key avoids.
    expect(calls.post).toHaveLength(1);
    expect(calls.post[0].body).toHaveProperty("id", 999);
  });
});
