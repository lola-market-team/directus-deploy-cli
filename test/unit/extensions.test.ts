import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushExtension, promoteExtension, statusExtensions } from "../../src/extensions.js";

async function scratchRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ext-"));
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel);
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(abs, contents, "utf8");
  }
  return root;
}

describe("pushExtension errors", () => {
  it("errors when the targets file has no matching target", async () => {
    const root = await scratchRepo({
      "extensions/chat/package.json": "{}",
      "directus-deploy.targets.json": JSON.stringify({
        targets: { test: { base_url: "https://x", ssh_host: "y", ssh_user: "runner", remote_extensions_path: "/opt" } },
      }),
    });
    await expect(
      pushExtension({
        extensionName: "chat",
        target: "staging",
        targetsFile: `${root}/directus-deploy.targets.json`,
        repoRoot: root,
        skipBuild: true,
      }),
    ).rejects.toThrow(/unknown target 'staging'/);
  });

  it("errors when the extension directory doesn't exist", async () => {
    const root = await scratchRepo({
      "directus-deploy.targets.json": JSON.stringify({
        targets: { test: { base_url: "https://x", ssh_host: "y", ssh_user: "runner", remote_extensions_path: "/opt" } },
      }),
    });
    await expect(
      pushExtension({
        extensionName: "missing",
        target: "test",
        targetsFile: `${root}/directus-deploy.targets.json`,
        repoRoot: root,
        skipBuild: true,
      }),
    ).rejects.toThrow(/no such extension: missing/);
  });
});

describe("promoteExtension errors", () => {
  it("errors when the targets file has no matching target", async () => {
    const root = await scratchRepo({
      "extensions/chat/package.json": "{}",
      "directus-deploy.targets.json": JSON.stringify({
        targets: { test: { base_url: "https://x", ssh_host: "y", ssh_user: "runner", remote_extensions_path: "/opt" } },
      }),
    });
    await expect(
      promoteExtension({
        extensionName: "chat",
        target: "prod",
        targetsFile: `${root}/directus-deploy.targets.json`,
        repoRoot: root,
      }),
    ).rejects.toThrow(/unknown target 'prod'/);
  });

  it("errors when the extension directory doesn't exist", async () => {
    const root = await scratchRepo({
      "directus-deploy.targets.json": JSON.stringify({
        targets: { prod: { base_url: "https://x", ssh_host: "y", ssh_user: "runner", remote_extensions_path: "/opt", build_forbidden: true } },
      }),
    });
    await expect(
      promoteExtension({
        extensionName: "missing",
        target: "prod",
        targetsFile: `${root}/directus-deploy.targets.json`,
        repoRoot: root,
      }),
    ).rejects.toThrow(/no such extension: missing/);
  });
});

describe("statusExtensions", () => {
  it("reports HTTP errors per extension without aborting the batch", async () => {
    const root = await scratchRepo({
      "extensions/chat/package.json": "{}",
      "extensions/geo/package.json": "{}",
      "directus-deploy.targets.json": JSON.stringify({
        targets: {
          test: {
            base_url: "https://127.0.0.1:1", // unreachable
            ssh_host: "x",
            ssh_user: "runner",
            remote_extensions_path: "/opt",
          },
        },
      }),
    });
    const rows = await statusExtensions({
      target: "test",
      targetsFile: `${root}/directus-deploy.targets.json`,
      repoRoot: root,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.name).toBe("chat");
    expect(rows[0]!.error).toBeDefined();
    expect(rows[0]!.sourceCommit).toBeNull();
  });
});
