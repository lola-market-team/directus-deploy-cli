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
  it("renders clean state when every cell is on the reference", () => {
    const report: DiffReport = {
      reference: "origin/master",
      targets: ["test", "staging"],
      rows: [
        {
          extension: "chat",
          cells: {
            test: {
              target: "test",
              sourceCommit: "ad45074eabcdef",
              onReference: true,
              containingBranches: ["origin/master"],
            },
            staging: {
              target: "staging",
              sourceCommit: "ad45074eabcdef",
              onReference: true,
              containingBranches: ["origin/master"],
            },
          },
        },
      ],
    };
    const out = renderDiff(report);
    expect(out).toMatch(/chat/);
    expect(out).toMatch(/ad45074e ✓/);
    expect(out).toMatch(/on origin\/master/);
  });

  it("surfaces WIP branch drift per target", () => {
    const report: DiffReport = {
      reference: "origin/master",
      targets: ["test", "staging"],
      rows: [
        {
          extension: "search",
          cells: {
            test: {
              target: "test",
              sourceCommit: "784910f4wip",
              onReference: false,
              containingBranches: ["origin/feat/listing-group-visibility"],
            },
            staging: {
              target: "staging",
              sourceCommit: "a0fbd027merged",
              onReference: true,
              containingBranches: ["origin/master"],
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

  it("labels an extension that isn't deployed anywhere", () => {
    const report: DiffReport = {
      reference: "origin/master",
      targets: ["test"],
      rows: [
        {
          extension: "unshipped",
          cells: {
            test: {
              target: "test",
              sourceCommit: null,
              onReference: false,
              containingBranches: [],
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
