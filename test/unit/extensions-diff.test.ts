import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDiff } from "../../src/extensions.js";
import type { DiffReport } from "../../src/extensions.js";

async function scratchRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diff-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return root;
}

describe("renderDiff", () => {
  it("renders clean state when every cell's tree hash matches the reference", () => {
    const treeHash = "a".repeat(40);
    const report: DiffReport = {
      reference: "origin/develop",
      targets: ["test", "staging"],
      rows: [
        {
          extension: "chat",
          referenceTreeHash: treeHash,
          cells: {
            test: {
              target: "test",
              sourceCommit: "ad45074eabcdef",
              deployedTreeHash: treeHash,
              matchesReference: true,
              branchHint: null,
            },
            staging: {
              target: "staging",
              sourceCommit: "ad45074eabcdef",
              deployedTreeHash: treeHash,
              matchesReference: true,
              branchHint: null,
            },
          },
        },
      ],
    };
    const out = renderDiff(report);
    expect(out).toMatch(/chat/);
    expect(out).toMatch(/ad45074e ✓/);
    expect(out).toMatch(/matches origin\/develop/);
  });

  it("surfaces WIP branch drift with a branch hint per target", () => {
    const refTree = "b".repeat(40);
    const wipTree = "c".repeat(40);
    const report: DiffReport = {
      reference: "origin/develop",
      targets: ["test", "staging"],
      rows: [
        {
          extension: "search",
          referenceTreeHash: refTree,
          cells: {
            test: {
              target: "test",
              sourceCommit: "784910f4wip",
              deployedTreeHash: wipTree,
              matchesReference: false,
              branchHint: "origin/feat/listing-group-visibility",
            },
            staging: {
              target: "staging",
              sourceCommit: "a0fbd027merged",
              deployedTreeHash: refTree,
              matchesReference: true,
              branchHint: null,
            },
          },
        },
      ],
    };
    const out = renderDiff(report);
    expect(out).toMatch(/search/);
    expect(out).toMatch(/784910f4 ✗/);
    expect(out).toMatch(/a0fbd027 ✓/);
    expect(out).toMatch(/test=origin\/feat\/listing/);
  });

  it("flags a deployed SHA that isn't in local git objects", () => {
    const report: DiffReport = {
      reference: "origin/develop",
      targets: ["test", "staging"],
      rows: [
        {
          extension: "search",
          referenceTreeHash: "d".repeat(40),
          cells: {
            test: {
              target: "test",
              sourceCommit: "784910f4wip",
              deployedTreeHash: null,          // SHA not fetched locally
              matchesReference: false,
              branchHint: null,
            },
            staging: {
              target: "staging",
              sourceCommit: "a0fbd027merged",
              deployedTreeHash: null,
              matchesReference: false,
              branchHint: null,
            },
          },
        },
      ],
    };
    const out = renderDiff(report);
    expect(out).toMatch(/784910f4 \?/);
    expect(out).toMatch(/not in local git/);
  });

  it("labels a source tree that's diverged from every known branch as orphaned", () => {
    const refTree = "e".repeat(40);
    const orphanTree = "f".repeat(40);
    const report: DiffReport = {
      reference: "origin/develop",
      targets: ["test"],
      rows: [
        {
          extension: "rental-reviews",
          referenceTreeHash: refTree,
          cells: {
            test: {
              target: "test",
              sourceCommit: "340e68d9orphan",
              deployedTreeHash: orphanTree,
              matchesReference: false,
              branchHint: null,  // no branch has this exact tree
            },
          },
        },
      ],
    };
    const out = renderDiff(report);
    expect(out).toMatch(/test=orphaned/);
  });

  it("labels an extension that isn't deployed anywhere", () => {
    const report: DiffReport = {
      reference: "origin/develop",
      targets: ["test"],
      rows: [
        {
          extension: "unshipped",
          referenceTreeHash: "1".repeat(40),
          cells: {
            test: {
              target: "test",
              sourceCommit: null,
              deployedTreeHash: null,
              matchesReference: false,
              branchHint: null,
              error: "HTTP 404",
            },
          },
        },
      ],
    };
    const out = renderDiff(report);
    expect(out).toMatch(/unshipped/);
    expect(out).toMatch(/not deployed anywhere/);
  });
});

describe("scratch repo shape (integration scaffold)", () => {
  it("creates a walkable extension list", async () => {
    const root = await scratchRepo({
      "extensions/chat/package.json": "{}",
      "extensions/geo/package.json": "{}",
    });
    // Not calling diffExtensions here (it needs fetch + git); the CLI harness
    // exercises that flow. This test just anchors the fixture shape.
    expect(root).toBeTruthy();
  });
});
