import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileRegister } from "../../src/reconcilers/register.js";
import type { DirectusClient } from "../../src/types.js";

async function registerDirWith(files: Record<string, unknown>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "register-"));
  const dir = join(root, "register");
  await mkdir(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(body), "utf8");
  }
  return dir;
}

// Branch on the SQL rather than call order — order-based stubs silently feed
// the wrong shape to a later query (a bare {ok:1} reaching the column walk
// makes metaFor() read data_type off undefined).
function rawQueryStub(opts: { adopted: boolean }) {
  return vi.fn(async (_path: string, body: unknown) => {
    const sql = String((body as { query?: unknown })?.query ?? "");
    const rows = (data: unknown[]) => ({ success: true, results: [{ success: true, data }] });
    if (sql.includes("information_schema.tables")) return rows([{ ok: 1 }]); // table exists
    if (sql.includes("directus_collections")) return rows(opts.adopted ? [{ ok: 1 }] : []);
    if (sql.includes("information_schema.columns")) return rows([]); // nothing left to register
    return rows([{ ok: 1 }]); // probe + INSERT
  });
}

// A raw-query client whose probe succeeds and whose every query returns no
// rows — so anything past the probe would take the "adopt / register" path.
function mockClient(overrides: Partial<DirectusClient> = {}): DirectusClient {
  return {
    get: vi.fn(async () => null),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    postRaw: vi.fn(async () => ({ success: true, results: [{ success: true, data: [] }] })),
    ...overrides,
  };
}

describe("reconcileRegister", () => {
  it("refuses a manifest for a Directus system collection", async () => {
    // Left unguarded this is actively destructive, not merely unsupported:
    // directus_users has no directus_collections row (system collections are
    // runtime-provided), so adoption would INSERT one and shadow it; and the
    // column walk would PATCH every column without a directus_fields row —
    // id, email, password, role.
    const dir = await registerDirWith({
      "directus_users.json": { table: "directus_users", fields: { charges_vat: { hidden: false } } },
    });
    const client = mockClient();
    const results = await reconcileRegister({
      registerDir: dir,
      client,
      opts: { dryRun: false },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("failed");
    expect(results[0]!.reason).toMatch(/system collection/);
    expect(results[0]!.reason).toMatch(/snapshot field/);

    // Only the probe may have run — no existence check, no adopt, no PATCH.
    expect((client.postRaw as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("clears the system schema cache after adopting a collection", async () => {
    // The adopt is a raw INSERT, which does not invalidate Directus's cached
    // SchemaOverview — so the column PATCHes that follow 403 with "collection
    // does not exist" until the cache is cleared. Observed on a real instance:
    // 7/7 PATCHes failed twice, then 7/7 succeeded after this call.
    const dir = await registerDirWith({
      "rental_holds.json": { table: "rental_holds" },
    });
    const client = mockClient({ postRaw: rawQueryStub({ adopted: false }) });
    await reconcileRegister({ registerDir: dir, client, opts: { dryRun: false } });

    const posts = (client.post as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(posts).toContain("/utils/cache/clear?system=true");
  });

  it("does not clear the cache when the collection was already adopted", async () => {
    // No adopt means no stale cache to clear — don't fire a needless flush on
    // every apply.
    const dir = await registerDirWith({
      "rental_holds.json": { table: "rental_holds" },
    });
    const client = mockClient({ postRaw: rawQueryStub({ adopted: true }) });
    await reconcileRegister({ registerDir: dir, client, opts: { dryRun: false } });

    const posts = (client.post as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(posts).not.toContain("/utils/cache/clear?system=true");
  });

  it("survives a cache-clear failure rather than aborting the run", async () => {
    const dir = await registerDirWith({
      "rental_holds.json": { table: "rental_holds" },
    });
    const client = mockClient({
      postRaw: rawQueryStub({ adopted: false }),
      post: vi.fn(async () => {
        throw new Error("503 cache endpoint disabled");
      }),
    });
    const results = await reconcileRegister({ registerDir: dir, client, opts: { dryRun: false } });
    // The adopt still counts as done; the throw must not propagate.
    expect(results.some((r) => r.label.includes("adopt") && r.action === "created")).toBe(true);
  });

  it("still processes ordinary tables alongside a rejected system manifest", async () => {
    // The guard must reject one manifest, not abort the whole run.
    const dir = await registerDirWith({
      "directus_users.json": { table: "directus_users" },
      "rental_holds.json": { table: "rental_holds" },
    });
    const client = mockClient();
    const results = await reconcileRegister({
      registerDir: dir,
      client,
      opts: { dryRun: false },
    });

    const labels = results.map((r) => r.label);
    expect(labels.some((l) => l.includes("directus_users"))).toBe(true);
    expect(labels.some((l) => l.includes("rental_holds"))).toBe(true);
    const users = results.find((r) => r.label.includes("directus_users"))!;
    expect(users.action).toBe("failed");
  });
});
