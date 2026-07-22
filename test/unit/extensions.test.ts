import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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

describe("pushExtension --via api contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  // Pins the ext-deploy body-mode contract (backend #378/#379): POST to
  // /ext-deploy/ — NOT /ext-deploy/<name> — with {name, sha256, tarball} in
  // the body. 0.21.0 shipped the name-in-path form, which no server version
  // ever routed; nothing asserted the request shape until this test.
  it("POSTs to /ext-deploy/ with the extension name in the body", async () => {
    const root = await scratchRepo({
      "extensions/chat/package.json": JSON.stringify({ name: "chat", version: "1.0.0" }),
      "extensions/chat/src/index.ts": "export {};",
      "extensions/chat/dist/index.js": "export default {};",
      "directus-deploy.targets.json": JSON.stringify({
        targets: { test: { base_url: "https://cms.example/", ssh_host: "y", ssh_user: "runner", remote_extensions_path: "/opt" } },
      }),
    });
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args]);
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "root");
    git("add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "chat");
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"]).toString().trim();

    vi.stubEnv("DIRECTUS_TEST_TOKEN", "tok-123");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/_meta")) {
        return new Response(JSON.stringify({ sourceCommit: sha }), { status: 200 });
      }
      return new Response(JSON.stringify({ installed: true }), { status: 200 });
    });

    const result = await pushExtension({
      extensionName: "chat",
      target: "test",
      targetsFile: `${root}/directus-deploy.targets.json`,
      repoRoot: root,
      skipBuild: true,
      via: "api",
    });

    const deploy = calls.find((c) => c.init?.method === "POST");
    expect(deploy).toBeDefined();
    expect(deploy!.url).toBe("https://cms.example/ext-deploy/");
    expect(deploy!.init!.headers).toMatchObject({ Authorization: "Bearer tok-123" });
    const body = JSON.parse(String(deploy!.init!.body));
    expect(body.name).toBe("chat");
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.tarball.length).toBeGreaterThan(0);
    expect(result.verifiedCommit).toBe(sha);
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
