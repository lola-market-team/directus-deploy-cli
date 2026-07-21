import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileSeeds } from "../../src/reconcilers/seeds.js";
import type { DirectusClient } from "../../src/types.js";

async function writeSeedDir(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "seed-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(body), "utf8");
  }
  return dir;
}

// Routes GET by path: /fields/<collection> serves field definitions (PK
// discovery), /items/<collection> serves current server rows.
function mockClient(opts: {
  fieldsByCollection?: Record<string, Record<string, unknown>[]>;
  itemsByCollection?: Record<string, Record<string, unknown>[]>;
  fieldsError?: boolean;
} = {}): DirectusClient {
  return {
    get: vi.fn(async (path: string) => {
      const fields = path.match(/^\/fields\/([^/?]+)/);
      if (fields) {
        if (opts.fieldsError) throw new Error("boom");
        return opts.fieldsByCollection?.[fields[1]!] ?? null;
      }
      const items = path.match(/^\/items\/([^/?]+)/);
      if (items) return opts.itemsByCollection?.[items[1]!] ?? [];
      return null;
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    postRaw: vi.fn(async () => ({})),
  };
}

const keyPkFields = [
  { collection: "notification_types", field: "key", type: "string", schema: { is_primary_key: true } },
  { collection: "notification_types", field: "label", type: "string", schema: {} },
];

describe("reconcileSeeds PK resolution (#32)", () => {
  it("creates rows keyed on a non-id primary key", async () => {
    const seedDir = await writeSeedDir({
      "notification_types.json": {
        collection: "notification_types",
        data: [{ key: "password_changed", label: "Password changed" }],
      },
    });
    const client = mockClient({ fieldsByCollection: { notification_types: keyPkFields } });
    const results = await reconcileSeeds({ seedDir, client, opts: { dryRun: false } });
    expect(results).toEqual([
      { kind: "seeds", label: "seeds/notification_types[password_changed]", action: "created" },
    ]);
    expect(client.post).toHaveBeenCalledWith("/items/notification_types", {
      key: "password_changed",
      label: "Password changed",
    });
  });

  it("matches existing rows by the resolved PK and PATCHes drift to /items/<collection>/<pk>", async () => {
    const seedDir = await writeSeedDir({
      "notification_types.json": {
        collection: "notification_types",
        data: [
          { key: "password_changed", label: "Password changed" },
          { key: "digest", label: "Digest" },
        ],
      },
    });
    const client = mockClient({
      fieldsByCollection: { notification_types: keyPkFields },
      itemsByCollection: {
        notification_types: [
          { key: "password_changed", label: "OLD LABEL" },
          { key: "digest", label: "Digest" },
        ],
      },
    });
    const results = await reconcileSeeds({ seedDir, client, opts: { dryRun: false } });
    expect(results.map((r) => r.action)).toEqual(["updated", "unchanged"]);
    expect(client.patch).toHaveBeenCalledWith("/items/notification_types/password_changed", {
      key: "password_changed",
      label: "Password changed",
    });
    expect(client.post).not.toHaveBeenCalled();
  });

  it("falls back to `id` when /fields returns null (403/404 from the real client)", async () => {
    const seedDir = await writeSeedDir({
      "messaging_templates.json": {
        collection: "messaging_templates",
        data: [{ id: 3, subject: "hi" }],
      },
    });
    // No fieldsByCollection entry → the mock's /fields route returns null,
    // mirroring http.ts get() on 403/404.
    const client = mockClient();
    const results = await reconcileSeeds({ seedDir, client, opts: { dryRun: false } });
    expect(results).toEqual([
      { kind: "seeds", label: "seeds/messaging_templates[3]", action: "created" },
    ]);
  });

  it("falls back to `id` when /fields is unavailable", async () => {
    const seedDir = await writeSeedDir({
      "messaging_templates.json": {
        collection: "messaging_templates",
        data: [{ id: 3, subject: "hi" }],
      },
    });
    const client = mockClient({ fieldsError: true });
    const results = await reconcileSeeds({ seedDir, client, opts: { dryRun: false } });
    expect(results).toEqual([
      { kind: "seeds", label: "seeds/messaging_templates[3]", action: "created" },
    ]);
  });

  it("id-keyed collections behave as before", async () => {
    const seedDir = await writeSeedDir({
      "messaging_templates.json": {
        collection: "messaging_templates",
        data: [{ id: 3, subject: "hi" }],
      },
    });
    const client = mockClient({
      fieldsByCollection: {
        messaging_templates: [
          { collection: "messaging_templates", field: "id", type: "integer", schema: { is_primary_key: true } },
        ],
      },
      itemsByCollection: { messaging_templates: [{ id: 3, subject: "hi" }] },
    });
    const results = await reconcileSeeds({ seedDir, client, opts: { dryRun: false } });
    expect(results).toEqual([
      { kind: "seeds", label: "seeds/messaging_templates[3]", action: "unchanged" },
    ]);
  });

  it("emits a visible skipped result for rows missing the PK instead of vanishing", async () => {
    const seedDir = await writeSeedDir({
      "notification_types.json": {
        collection: "notification_types",
        data: [{ label: "no key here" }, { key: "ok", label: "fine" }],
      },
    });
    const client = mockClient({ fieldsByCollection: { notification_types: keyPkFields } });
    const results = await reconcileSeeds({ seedDir, client, opts: { dryRun: false } });
    expect(results).toEqual([
      {
        kind: "seeds",
        label: "seeds/notification_types[row 0]",
        action: "skipped",
        reason: "row has no value for primary key 'key'",
      },
      { kind: "seeds", label: "seeds/notification_types[ok]", action: "created" },
    ]);
  });

  it("dry-run reports creates without writing", async () => {
    const seedDir = await writeSeedDir({
      "notification_types.json": {
        collection: "notification_types",
        data: [{ key: "password_changed", label: "Password changed" }],
      },
    });
    const client = mockClient({ fieldsByCollection: { notification_types: keyPkFields } });
    const results = await reconcileSeeds({ seedDir, client, opts: { dryRun: true } });
    expect(results.map((r) => r.action)).toEqual(["created"]);
    expect(client.post).not.toHaveBeenCalled();
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("resolves the PK once per collection", async () => {
    const seedDir = await writeSeedDir({
      "a_notification_types.json": {
        collection: "notification_types",
        data: [{ key: "a" }],
      },
      "b_notification_types.json": {
        collection: "notification_types",
        data: [{ key: "b" }],
      },
    });
    const client = mockClient({ fieldsByCollection: { notification_types: keyPkFields } });
    await reconcileSeeds({ seedDir, client, opts: { dryRun: true } });
    const fieldCalls = (client.get as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).startsWith("/fields/"),
    );
    expect(fieldCalls).toHaveLength(1);
  });
});
