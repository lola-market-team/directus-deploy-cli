import { describe, expect, it } from "vitest";
import { summarize } from "../../src/runner.js";

// verify semantics: strict pass requires zero created + zero updated +
// zero failed. `skipped` is intentional (adopted raw-SQL columns,
// register-managed collections) and never counts as drift.

describe("verify semantics", () => {
  it("passes when every entity is unchanged or skipped", () => {
    const report = summarize(
      [
        { kind: "fields", label: "listings.title", action: "unchanged" },
        { kind: "fields", label: "categories.embedding", action: "skipped" },
      ],
      "test",
    );
    expect(report.counts.created).toBe(0);
    expect(report.counts.updated).toBe(0);
    expect(report.counts.failed).toBe(0);
    // strict verifier: pass
    const drift = report.counts.created + report.counts.updated;
    expect(drift).toBe(0);
  });

  it("fails when an entity would be created", () => {
    const report = summarize(
      [{ kind: "collections", label: "listings", action: "created" }],
      "test",
    );
    const drift = report.counts.created + report.counts.updated;
    expect(drift).toBeGreaterThan(0);
  });

  it("fails when an entity would be updated", () => {
    const report = summarize(
      [
        {
          kind: "permissions",
          label: "listings.read(x)",
          action: "updated",
        },
      ],
      "test",
    );
    const drift = report.counts.created + report.counts.updated;
    expect(drift).toBe(1);
  });

  it("skipped-only never counts as drift, even in bulk", () => {
    const report = summarize(
      new Array(50).fill({
        kind: "fields",
        label: "x.y",
        action: "skipped",
      }),
      "test",
    );
    const drift = report.counts.created + report.counts.updated;
    expect(drift).toBe(0);
    expect(report.counts.skipped).toBe(50);
  });
});
