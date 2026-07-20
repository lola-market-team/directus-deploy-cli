import { describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { adoptMigrations, normalizeSqlForHash, reconcileMigrations } from "../../src/reconcilers/migrations.js";
import type { DirectusClient } from "../../src/types.js";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

async function writeMigrations(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mig-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, "utf8");
  }
  return dir;
}

// Mock /raw-query/execute. Each call gets routed by looking at the SQL text.
// The mock keeps an in-memory tracker map that mimics the real table.
interface FakeRawQuery {
  client: DirectusClient;
  tracker: Map<string, string>; // filename → sha256
  executedStatements: string[];
  probeAvailable: boolean;
}

function makeMockClient(opts: { probeAvailable?: boolean; preSeed?: Map<string, string> } = {}): FakeRawQuery {
  const tracker = new Map(opts.preSeed ?? []);
  const executedStatements: string[] = [];
  const probeAvailable = opts.probeAvailable ?? true;

  const postRaw = vi.fn(async (path: string, body: unknown) => {
    if (path !== "/raw-query/execute") return {};
    const query = (body as { query?: string })?.query ?? "";

    // Endpoint unavailable — simulate 404.
    if (!probeAvailable) {
      const err = new Error("404 /raw-query/execute :: not found") as Error & { status: number };
      (err as unknown as { status: number }).status = 404;
      // The reconciler catches string ' 404 ' — include it.
      throw new Error(" 404 /raw-query/execute :: not found");
    }

    const trimmed = query.trim();
    // Probe.
    if (/^SELECT\s+1\s+AS\s+ok/i.test(trimmed)) {
      return { success: true, results: [{ success: true, data: [{ ok: 1 }] }] };
    }
    // CREATE TABLE tracker.
    if (/^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+_directus_deploy_migrations/i.test(trimmed)) {
      return { success: true, results: [{ success: true, data: [] }] };
    }
    // SELECT tracker.
    if (/^SELECT\s+filename,\s+sha256\s+FROM\s+_directus_deploy_migrations/i.test(trimmed)) {
      const data = Array.from(tracker.entries()).map(([filename, sha256]) => ({ filename, sha256 }));
      return { success: true, results: [{ success: true, data }] };
    }
    // INSERT tracker.
    const insertMatch = trimmed.match(/^INSERT\s+INTO\s+_directus_deploy_migrations\s+\(filename,\s+sha256\)\s+VALUES\s+\('([^']+)',\s+'([^']+)'\)/i);
    if (insertMatch) {
      const [, filename, sha256] = insertMatch;
      if (!tracker.has(filename!)) tracker.set(filename!, sha256!);
      return { success: true, results: [{ success: true, data: [] }] };
    }
    // Anything else: real migration SQL statement.
    executedStatements.push(query);
    return { success: true, results: [{ success: true, data: [] }] };
  });

  const client: DirectusClient = {
    get: vi.fn(async () => null),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    postRaw,
  };

  return { client, tracker, executedStatements, probeAvailable };
}

describe("reconcileMigrations", () => {
  it("marks unchanged when filename+hash match tracker (no execution)", async () => {
    const body = "CREATE TABLE IF NOT EXISTS x (id int);";
    const dir = await writeMigrations({ "001.sql": body });
    const fake = makeMockClient({ preSeed: new Map([["001.sql", sha256(body)]]) });

    const results = await reconcileMigrations({
      migrationsDir: dir,
      client: fake.client,
      opts: { dryRun: false },
    });

    expect(results).toEqual([{ kind: "migrations", label: "migrations/001.sql", action: "unchanged" }]);
    expect(fake.executedStatements).toEqual([]);
  });

  it("applies a NEW file, then inserts a tracker row with the file's hash", async () => {
    const body = "CREATE TABLE IF NOT EXISTS y (id int);";
    const dir = await writeMigrations({ "002.sql": body });
    const fake = makeMockClient();

    const results = await reconcileMigrations({
      migrationsDir: dir,
      client: fake.client,
      opts: { dryRun: false },
    });

    expect(results).toEqual([{ kind: "migrations", label: "migrations/002.sql", action: "created" }]);
    expect(fake.executedStatements).toEqual(["CREATE TABLE IF NOT EXISTS y (id int);"]);
    expect(fake.tracker.get("002.sql")).toBe(sha256(body));
  });

  it("fails hard when hash differs from tracker (MUTATED — never rewrites silently)", async () => {
    const body = "CREATE TABLE IF NOT EXISTS z (id int);";
    const staleHash = sha256("something else");
    const dir = await writeMigrations({ "003.sql": body });
    const fake = makeMockClient({ preSeed: new Map([["003.sql", staleHash]]) });

    const results = await reconcileMigrations({
      migrationsDir: dir,
      client: fake.client,
      opts: { dryRun: false },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("failed");
    expect(results[0]!.reason).toMatch(/content mismatch/);
    expect(fake.executedStatements).toEqual([]);
    // Tracker unchanged.
    expect(fake.tracker.get("003.sql")).toBe(staleHash);
  });

  it("does not insert a tracker row when the SQL fails partway", async () => {
    const body = "CREATE TABLE x (id int); INSERT INTO x VALUES (1);";
    const dir = await writeMigrations({ "004.sql": body });
    const fake = makeMockClient();
    // Fail the INSERT statement.
    (fake.client.postRaw as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ({
      success: true,
      results: [{ success: true, data: [{ ok: 1 }] }], // probe
    })).mockImplementationOnce(async () => ({
      success: true,
      results: [{ success: true, data: [] }], // create tracker
    })).mockImplementationOnce(async () => ({
      success: true,
      results: [{ success: true, data: [] }], // fetch tracker (empty)
    })).mockImplementationOnce(async () => ({
      success: true,
      results: [{ success: true, data: [] }], // CREATE TABLE ok
    })).mockImplementationOnce(async () => ({
      success: true,
      results: [{ success: false, error: "insert broke" }], // INSERT fails
    }));

    const results = await reconcileMigrations({
      migrationsDir: dir,
      client: fake.client,
      opts: { dryRun: false },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.action).toBe("failed");
    expect(results[0]!.reason).toBe("insert broke");
    expect(fake.tracker.has("004.sql")).toBe(false);
  });

  it("skips cleanly when /raw-query/execute is not deployed on the target", async () => {
    const dir = await writeMigrations({ "005.sql": "SELECT 1;" });
    const fake = makeMockClient({ probeAvailable: false });

    const results = await reconcileMigrations({
      migrationsDir: dir,
      client: fake.client,
      opts: { dryRun: false },
    });

    expect(results).toEqual([
      { kind: "migrations", label: "migrations", action: "skipped", reason: expect.stringContaining("not available") },
    ]);
  });

  it("dry-run reports NEW as created (would apply) without executing", async () => {
    const body = "CREATE TABLE IF NOT EXISTS q (id int);";
    const dir = await writeMigrations({ "006.sql": body });
    const fake = makeMockClient();

    const results = await reconcileMigrations({
      migrationsDir: dir,
      client: fake.client,
      opts: { dryRun: true },
    });

    expect(results[0]!.action).toBe("created");
    expect(results[0]!.reason).toMatch(/would apply/);
    expect(fake.executedStatements).toEqual([]);
    expect(fake.tracker.has("006.sql")).toBe(false);
  });
});

describe("adoptMigrations", () => {
  it("inserts (filename, sha256) rows without executing SQL", async () => {
    const bodyA = "CREATE TABLE a (id int);";
    const bodyB = "CREATE TABLE b (id int);";
    const dir = await writeMigrations({ "01.sql": bodyA, "02.sql": bodyB });
    const fake = makeMockClient();

    const results = await adoptMigrations({
      migrationsDir: dir,
      client: fake.client,
      opts: { dryRun: false },
    });

    expect(results.map((r) => r.action)).toEqual(["created", "created"]);
    expect(fake.executedStatements).toEqual([]);
    expect(fake.tracker.get("01.sql")).toBe(sha256(bodyA));
    expect(fake.tracker.get("02.sql")).toBe(sha256(bodyB));
  });

  it("is idempotent: re-adopting matched rows is a no-op", async () => {
    const body = "CREATE TABLE a (id int);";
    const dir = await writeMigrations({ "01.sql": body });
    const fake = makeMockClient({ preSeed: new Map([["01.sql", sha256(body)]]) });

    const results = await adoptMigrations({
      migrationsDir: dir,
      client: fake.client,
      opts: { dryRun: false },
    });

    expect(results.map((r) => r.action)).toEqual(["unchanged"]);
  });

  it("refuses to overwrite a tracker row with a different hash", async () => {
    const body = "CREATE TABLE a (id int);";
    const staleHash = sha256("earlier version");
    const dir = await writeMigrations({ "01.sql": body });
    const fake = makeMockClient({ preSeed: new Map([["01.sql", staleHash]]) });

    const results = await adoptMigrations({
      migrationsDir: dir,
      client: fake.client,
      opts: { dryRun: false },
    });

    expect(results[0]!.action).toBe("failed");
    expect(results[0]!.reason).toMatch(/already adopted/);
    expect(fake.tracker.get("01.sql")).toBe(staleHash);
  });
});

describe("normalizeSqlForHash", () => {
  it("ignores comment-only differences", () => {
    // The whole point: fixing a typo or removing a ';' from a comment in an
    // applied migration must not trip the immutability check.
    const before = `-- adds max_uses to cap redemptions;\nALTER TABLE t ADD COLUMN a int;\n`;
    const after = `-- adds max_uses to cap redemptions.\n-- extra prose nobody executes\nALTER TABLE t ADD COLUMN a int;\n`;
    expect(normalizeSqlForHash(before)).toBe(normalizeSqlForHash(after));
  });

  it("ignores whitespace and blank-line churn", () => {
    const a = `ALTER TABLE t ADD COLUMN a int;`;
    const b = `\n\nALTER  TABLE   t\n  ADD COLUMN a int;\n\n`;
    expect(normalizeSqlForHash(a)).toBe(normalizeSqlForHash(b));
  });

  it("still detects a real SQL change", () => {
    const a = `ALTER TABLE t ADD COLUMN a int;`;
    const b = `ALTER TABLE t ADD COLUMN a bigint;`;
    expect(normalizeSqlForHash(a)).not.toBe(normalizeSqlForHash(b));
  });

  it("does not strip a '--' inside a string literal", () => {
    // Naive comment stripping would truncate this INSERT mid-value and make
    // two genuinely different migrations hash identically.
    const a = `INSERT INTO t (note) VALUES ('a -- not a comment');`;
    const b = `INSERT INTO t (note) VALUES ('a -- different text');`;
    expect(normalizeSqlForHash(a)).toContain("-- not a comment");
    expect(normalizeSqlForHash(a)).not.toBe(normalizeSqlForHash(b));
  });

  it("handles doubled quotes without losing track of the literal", () => {
    // SQL escapes a quote by doubling it; parity must survive that.
    const sql = `INSERT INTO t (note) VALUES ('it''s fine'); -- trailing comment`;
    const out = normalizeSqlForHash(sql);
    expect(out).toContain("it''s fine");
    expect(out).not.toContain("trailing comment");
  });

  it("leaves block comments alone", () => {
    // /* */ can sit mid-expression where removing it would join tokens.
    const sql = `SELECT a /* inline */ FROM t;`;
    expect(normalizeSqlForHash(sql)).toContain("/* inline */");
  });
});
