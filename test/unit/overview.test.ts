import { describe, expect, it } from "vitest";
import {
  classifyPromotionPaths,
  inferPromotionPair,
  renderOverview,
  hasDrift,
  hasErrors,
} from "../../src/overview.js";
import type { OverviewReport, TargetOverview } from "../../src/overview.js";

describe("classifyPromotionPaths", () => {
  it("routes each deployable path to its dimension", () => {
    const out = classifyPromotionPaths([
      { status: "A", path: "migrations/043_add_x.sql" },
      { status: "M", path: "migrations/010_old.sql" },
      { status: "D", path: "migrations/001_dead.sql" },
      { status: "A", path: "extensions/chat/migrations/002_threads.sql" },
      { status: "A", path: "migrations/register/rentals.json" },
      { status: "M", path: "directus_config/snapshot/collections/listings.json" },
      { status: "A", path: "directus_config/collections/permissions.json" },
      { status: "M", path: "directus_config/seed/categories.json" },
      { status: "M", path: "extensions/chat/src/index.ts" },
      { status: "M", path: "extensions/chat/src/lib/db.ts" },
      { status: "M", path: "extensions/rental-fsm/src/machine.ts" },
      // noise that must not count anywhere
      { status: "M", path: "extensions/chat/README.md" },
      { status: "M", path: "extensions/chat/dist/api.js" },
    ]);
    expect(out.migrations.added).toEqual(["043_add_x.sql", "ext/chat/002_threads.sql"]);
    expect(out.migrations.modified).toEqual(["010_old.sql"]);
    expect(out.migrations.removed).toEqual(["001_dead.sql"]);
    expect(out.extensions).toEqual(["chat", "rental-fsm"]);
    expect(out.schema).toEqual([
      "directus_config/collections/permissions.json",
      "directus_config/snapshot/collections/listings.json",
      "migrations/register/rentals.json",
    ]);
    expect(out.seeds).toEqual(["directus_config/seed/categories.json"]);
  });

  it("returns empty buckets for an empty diff", () => {
    const out = classifyPromotionPaths([]);
    expect(out.migrations).toEqual({ added: [], modified: [], removed: [] });
    expect(out.extensions).toEqual([]);
    expect(out.schema).toEqual([]);
    expect(out.seeds).toEqual([]);
  });
});

describe("inferPromotionPair", () => {
  it("picks the build_forbidden target's ref as the destination", () => {
    const pair = inferPromotionPair([
      { ref: "origin/develop", buildForbidden: false },
      { ref: "origin/develop", buildForbidden: false },
      { ref: "origin/master", buildForbidden: true },
    ]);
    expect(pair).toEqual({ from: "origin/develop", to: "origin/master" });
  });

  it("skips when refs don't split into exactly two", () => {
    const one = inferPromotionPair([
      { ref: "origin/develop", buildForbidden: false },
      { ref: "origin/develop", buildForbidden: true },
    ]);
    expect(one).toHaveProperty("skipped");
    const three = inferPromotionPair([
      { ref: "origin/a", buildForbidden: false },
      { ref: "origin/b", buildForbidden: false },
      { ref: "origin/c", buildForbidden: true },
    ]);
    expect(three).toHaveProperty("skipped");
  });

  it("skips when no build_forbidden target pins the destination", () => {
    const pair = inferPromotionPair([
      { ref: "origin/develop", buildForbidden: false },
      { ref: "origin/master", buildForbidden: false },
    ]);
    expect(pair).toHaveProperty("skipped");
  });
});

function cleanTarget(name: string, ref: string): TargetOverview {
  return {
    target: name,
    ref,
    migrations: { applied: 42, pending: 0, mutated: 0, pendingList: [], mutatedList: [] },
    extensions: { match: 7, drift: 0, missing: 0, driftList: [], missingList: [] },
    config: { changes: 0, changeList: [] },
    seeds: { changes: 0, changeList: [] },
  };
}

describe("renderOverview / hasDrift / hasErrors", () => {
  it("renders an all-green matrix with the promotion column", () => {
    const report: OverviewReport = {
      targets: [cleanTarget("test", "origin/develop"), cleanTarget("prod", "origin/master")],
      promotion: {
        from: "origin/develop",
        to: "origin/master",
        commitsAhead: 14,
        commitsBehind: 0,
        migrations: { added: ["043_x.sql"], modified: [], removed: [] },
        extensions: ["chat"],
        schema: [],
        seeds: [],
      },
    };
    const out = renderOverview(report);
    expect(out).toMatch(/test/);
    expect(out).toMatch(/vs origin\/develop/);
    expect(out).toMatch(/develop → master/);
    expect(out).toMatch(/✓ 42 applied/);
    expect(out).toMatch(/✓ 7\/7 match/);
    expect(out).toMatch(/1 new/);
    expect(out).toMatch(/14 commit\(s\) ahead/);
    expect(out).toMatch(/queued migration: 043_x\.sql/);
    expect(out).toMatch(/All environments in sync\./);
    expect(hasDrift(report)).toBe(false);
    expect(hasErrors(report)).toBe(false);
  });

  it("surfaces drift details and flags unreachable dimensions", () => {
    const staging = cleanTarget("staging", "origin/develop");
    staging.migrations = {
      applied: 40,
      pending: 2,
      mutated: 0,
      pendingList: ["043_x.sql", "044_y.sql"],
      mutatedList: [],
    };
    const prod = cleanTarget("prod", "origin/master");
    prod.extensions = {
      match: 6,
      drift: 1,
      missing: 0,
      driftList: [{ name: "rental-fsm", hint: "feat/foo" }],
      missingList: [],
    };
    prod.seeds = { error: "DIRECTUS_PROD_TOKEN not set" };
    const report: OverviewReport = {
      targets: [staging, prod],
      promotion: null,
      promotionSkipped: "need exactly 2 distinct refs",
    };
    const out = renderOverview(report);
    expect(out).toMatch(/✗ 2 pending/);
    expect(out).toMatch(/staging migrations pending: 043_x\.sql, 044_y\.sql/);
    expect(out).toMatch(/✗ 1 behind/);
    expect(out).toMatch(/rental-fsm differs from origin\/master — running feat\/foo/);
    expect(out).toMatch(/⚠ prod seeds: DIRECTUS_PROD_TOKEN not set/);
    expect(out).toMatch(/promotion column skipped: need exactly 2 distinct refs/);
    expect(out).toMatch(/Drift detected\./);
    expect(hasDrift(report)).toBe(true);
    expect(hasErrors(report)).toBe(true);
  });

  it("reports errors-only state distinctly from drift", () => {
    const t = cleanTarget("test", "origin/develop");
    t.migrations = { error: "could not materialize origin/develop" };
    const report: OverviewReport = { targets: [t], promotion: null };
    const out = renderOverview(report);
    expect(out).toMatch(/No drift found, but some checks could not run\./);
    expect(hasDrift(report)).toBe(false);
    expect(hasErrors(report)).toBe(true);
  });
});
