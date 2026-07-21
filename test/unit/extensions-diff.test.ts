import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffExtensions, renderDiff } from "../../src/extensions.js";
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

describe("diffExtensions with unresolvable deployed SHAs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function gitFixture(): Promise<{ repoRoot: string; targetsFile: string; headSha: string }> {
    const repoRoot = await mkdtemp(join(tmpdir(), "diff-git-"));
    await mkdir(join(repoRoot, "extensions/chat/src"), { recursive: true });
    await writeFile(join(repoRoot, "extensions/chat/package.json"), "{}", "utf8");
    await writeFile(join(repoRoot, "extensions/chat/src/index.ts"), "export {}\n", "utf8");
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repoRoot, encoding: "utf8" }).trim();
    git("init -q");
    git("-c user.email=t@t -c user.name=t commit -q --allow-empty -m root");
    git("add .");
    git("-c user.email=t@t -c user.name=t commit -q -m ext");
    const headSha = git("rev-parse --short HEAD");
    const targetsFile = join(repoRoot, "targets.json");
    await writeFile(
      targetsFile,
      JSON.stringify({
        targets: {
          test: {
            base_url: "http://localhost:1",
            ssh_host: "unused",
            ssh_user: "unused",
            remote_extensions_path: "/unused",
          },
        },
      }),
      "utf8",
    );
    return { repoRoot, targetsFile, headSha };
  }

  it("reports an error cell — not drift — when the deployed commit isn't in local git", async () => {
    const { repoRoot, targetsFile } = await gitFixture();
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ sourceCommit: "deadbeef" }),
    }));
    const report = await diffExtensions({ targetsFile, repoRoot, reference: "HEAD" });
    const cell = report.rows[0]!.cells["test"]!;
    expect(cell.error).toMatch(/not in local git/);
    expect(cell.deployedTreeHash).toBeNull();
    expect(cell.matchesReference).toBe(false);
  });

  it("matches when the deployed commit resolves to the reference tree", async () => {
    const { repoRoot, targetsFile, headSha } = await gitFixture();
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ sourceCommit: headSha }),
    }));
    const report = await diffExtensions({ targetsFile, repoRoot, reference: "HEAD" });
    const cell = report.rows[0]!.cells["test"]!;
    expect(cell.error).toBeUndefined();
    expect(cell.matchesReference).toBe(true);
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
