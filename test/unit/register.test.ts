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
