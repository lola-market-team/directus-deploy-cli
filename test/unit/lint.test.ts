import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintMigrations } from "../../src/lint.js";

async function scratch(files: Record<string, string>): Promise<{
  migrationsDir: string;
  registerDir: string;
  snapshotDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "lint-"));
  const migrationsDir = join(root, "migrations");
  const registerDir = join(root, "migrations", "register");
  const snapshotDir = join(root, "snapshot");
  await mkdir(migrationsDir, { recursive: true });
  await mkdir(registerDir, { recursive: true });
  await mkdir(snapshotDir, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const abs = join(root, path);
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return { migrationsDir, registerDir, snapshotDir };
}

describe("lintMigrations", () => {
  it("passes when ADD COLUMN is covered by a register manifest", async () => {
    const dirs = await scratch({
      "migrations/001.sql": `
        ALTER TABLE group_invites
          ADD COLUMN IF NOT EXISTS max_uses integer,
          ADD COLUMN IF NOT EXISTS uses_count integer NOT NULL DEFAULT 0;
      `,
      "migrations/register/group_invites.json": JSON.stringify({
        table: "group_invites",
        fields: { max_uses: {}, uses_count: {} },
      }),
    });
    const { violations } = await lintMigrations(dirs);
    expect(violations).toEqual([]);
  });

  it("passes when the table manifest exists with no fields subkey (walk-all)", async () => {
    const dirs = await scratch({
      "migrations/001.sql": `ALTER TABLE t ADD COLUMN IF NOT EXISTS a text;`,
      "migrations/register/t.json": JSON.stringify({ table: "t" }),
    });
    const { violations } = await lintMigrations(dirs);
    expect(violations).toEqual([]);
  });

  it("passes when ADD COLUMN is covered by a snapshot field with a real type", async () => {
    const dirs = await scratch({
      "migrations/001.sql": `ALTER TABLE users ADD COLUMN nickname text;`,
      "snapshot/fields/users/nickname.json": JSON.stringify({
        collection: "users",
        field: "nickname",
        type: "string",
      }),
    });
    const { violations } = await lintMigrations(dirs);
    expect(violations).toEqual([]);
  });

  it("fails when snapshot field has type='unknown' (must add manifest)", async () => {
    const dirs = await scratch({
      "migrations/001.sql": `ALTER TABLE t ADD COLUMN period tstzrange;`,
      "snapshot/fields/t/period.json": JSON.stringify({ type: "unknown" }),
    });
    const { violations } = await lintMigrations(dirs);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe("column");
    expect(violations[0]!.column).toBe("period");
    expect(violations[0]!.reason).toMatch(/type='unknown'/);
  });

  it("fails when ADD COLUMN has neither manifest nor snapshot", async () => {
    const dirs = await scratch({
      "migrations/001.sql": `ALTER TABLE t ADD COLUMN c text;`,
    });
    const { violations } = await lintMigrations(dirs);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe("column");
    expect(violations[0]!.column).toBe("c");
  });

  it("fails when CREATE TABLE has no manifest and no snapshot collection", async () => {
    const dirs = await scratch({
      "migrations/001.sql": `CREATE TABLE IF NOT EXISTS newthing (id int);`,
    });
    const { violations } = await lintMigrations(dirs);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe("table");
    expect(violations[0]!.table).toBe("newthing");
  });

  it("passes when CREATE TABLE has a snapshot collection", async () => {
    const dirs = await scratch({
      "migrations/001.sql": `CREATE TABLE newthing (id int);`,
      "snapshot/collections/newthing.json": JSON.stringify({ collection: "newthing" }),
    });
    const { violations } = await lintMigrations(dirs);
    expect(violations).toEqual([]);
  });

  it("ignores CREATE INDEX / DROP / data-only migrations", async () => {
    const dirs = await scratch({
      "migrations/001.sql": `
        CREATE INDEX IF NOT EXISTS idx_t_a ON t (a);
        DROP INDEX IF EXISTS foo;
        UPDATE t SET a = 1 WHERE b = 2;
        DELETE FROM t WHERE a IS NULL;
      `,
    });
    const { violations } = await lintMigrations(dirs);
    expect(violations).toEqual([]);
  });

  it("handles line + block comments without spurious matches", async () => {
    const dirs = await scratch({
      "migrations/001.sql": `
        -- ALTER TABLE fake ADD COLUMN c text;
        /* CREATE TABLE fake2 (id int); */
        CREATE INDEX IF NOT EXISTS idx_t_x ON t (x);
      `,
    });
    const { violations } = await lintMigrations(dirs);
    expect(violations).toEqual([]);
  });
});
