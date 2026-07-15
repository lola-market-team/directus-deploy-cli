import { describe, expect, it } from "vitest";
import { splitSql } from "../../src/sql.js";

describe("splitSql", () => {
  it("splits simple statements on ;", () => {
    expect(splitSql("SELECT 1; SELECT 2;")).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("ignores ; inside -- line comments", () => {
    const s = `
      -- foo; bar
      CREATE INDEX IF NOT EXISTS x ON y (z);
    `;
    const parts = splitSql(s);
    expect(parts.length).toBe(1);
    expect(parts[0]).toMatch(/CREATE INDEX/);
  });

  it("ignores ; inside /* block comments */", () => {
    const s = `/* one; two; three */ SELECT 1;`;
    expect(splitSql(s)).toEqual(["/* one; two; three */ SELECT 1;"]);
  });

  it("ignores ; inside single-quoted strings", () => {
    const s = `INSERT INTO t (msg) VALUES ('a; b'); SELECT 1;`;
    expect(splitSql(s)).toEqual([
      "INSERT INTO t (msg) VALUES ('a; b');",
      "SELECT 1;",
    ]);
  });

  it("handles doubled-quote escape inside strings", () => {
    const s = `INSERT INTO t VALUES ('it''s ok'); SELECT 1;`;
    expect(splitSql(s)).toEqual(["INSERT INTO t VALUES ('it''s ok');", "SELECT 1;"]);
  });

  it("respects dollar-quoted blocks", () => {
    const s = `DO $$ BEGIN RAISE NOTICE 'a; b'; END $$; SELECT 1;`;
    const parts = splitSql(s);
    expect(parts.length).toBe(2);
    expect(parts[0]).toMatch(/DO \$\$/);
    expect(parts[1]).toBe("SELECT 1;");
  });

  it("handles tagged dollar-quotes", () => {
    const s = `DO $body$ SELECT 'a; b'; $body$; SELECT 1;`;
    const parts = splitSql(s);
    expect(parts.length).toBe(2);
  });

  it("collapses trailing whitespace / blank output", () => {
    expect(splitSql("   ")).toEqual([]);
    expect(splitSql(";;;")).toEqual([";", ";", ";"]);
  });
});
