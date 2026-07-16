import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// Extension deploy over plain SSH.
//
//   directus-deploy extensions push <name> --target <env> --targets-file <path>
//   directus-deploy extensions status --target <env>
//
// MVP scope:
//   - Local build (npm ci + npm run build in extensions/<name>)
//   - Rsync the built dist/ to <ssh_user>@<ssh_host>:<remote_path>/<name>_new/
//   - SSH `mv <name>_new <name>` for atomic swap
//   - GET https://<env-host>/<name>/_meta and verify sourceCommit matches
//
// Explicitly NOT in scope for v0.5 (call the existing bash script for these):
//   - Build-once/promote-many via a shared artifact bucket
//   - Prod deploys (would need artifact-promotion path)
//   - New-extension bootstrap that requires a container restart
//
// Config is a JSON file (see TargetsFile). One file per repo, checked in.

export interface TargetsFile {
  targets: Record<string, TargetConfig>;
}

export interface TargetConfig {
  base_url: string;                // https://test.lola.market — for /_meta verify
  ssh_host: string;                // hostname/IP the SSH client resolves
  ssh_user: string;                // the user on the VM (typically "runner")
  remote_extensions_path: string;  // e.g. /opt/directus/extensions
  ssh_key_env?: string;            // env var holding path to private key (defaults to $LOLA_EXT_SSH_KEY)
}

export interface PushInput {
  extensionName: string;
  target: string;
  targetsFile: string;
  repoRoot: string;
  skipBuild?: boolean;
}

export interface PushResult {
  extensionName: string;
  target: string;
  sourceCommit: string;
  buildDurationMs: number;
  transportDurationMs: number;
  verifiedCommit: string | null;
}

async function loadTargets(path: string): Promise<TargetsFile> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as TargetsFile;
  if (!parsed?.targets || typeof parsed.targets !== "object") {
    throw new Error(`invalid targets file at ${path}: missing 'targets' object`);
  }
  return parsed;
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => rej(e));
    child.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

async function assertCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; label?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  const r = await runCommand(cmd, args, opts);
  if (r.code !== 0) {
    const label = opts.label ?? `${cmd} ${args.join(" ")}`;
    throw new Error(`${label} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r;
}

async function resolveSourceCommit(repoRoot: string, extName: string): Promise<string> {
  // Match scripts/deploy-extension.sh:
  //   git -C <root> log -1 --format=%h -- extensions/<name> :!extensions/<name>/dist :!extensions/<name>/src/build-info.ts
  const r = await assertCommand(
    "git",
    [
      "-C",
      repoRoot,
      "log",
      "-1",
      "--format=%H",
      "--",
      `extensions/${extName}`,
      `:!extensions/${extName}/dist`,
      `:!extensions/${extName}/src/build-info.ts`,
    ],
    { label: "git log source commit" },
  );
  const commit = r.stdout.trim();
  if (!commit) throw new Error(`could not resolve source commit for ${extName}`);
  return commit;
}

async function build(extDir: string): Promise<void> {
  // Assume workspace deps already installed at the repo root. If node_modules/.bin
  // is missing in the extension dir, install it.
  const hasBin = existsSync(join(extDir, "node_modules", ".bin", "directus-extension"));
  if (!hasBin) {
    await assertCommand("npm", ["ci"], { cwd: extDir, label: `npm ci ${extDir}` });
  }
  await assertCommand("npm", ["run", "build"], { cwd: extDir, label: `npm run build ${extDir}` });
}

function sshArgs(target: TargetConfig, extraOpts: string[] = []): string[] {
  const keyPath = target.ssh_key_env
    ? process.env[target.ssh_key_env]
    : process.env.LOLA_EXT_SSH_KEY;
  const args: string[] = [];
  if (keyPath) args.push("-i", keyPath);
  args.push(
    "-o", "StrictHostKeyChecking=no",
    "-o", "IdentitiesOnly=yes",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    ...extraOpts,
  );
  return args;
}

async function ssh(target: TargetConfig, remoteCmd: string): Promise<string> {
  const args = [...sshArgs(target), `${target.ssh_user}@${target.ssh_host}`, remoteCmd];
  const r = await assertCommand("ssh", args, { label: `ssh: ${remoteCmd.slice(0, 60)}` });
  return r.stdout;
}

async function rsyncToRemote(target: TargetConfig, localPath: string, remotePath: string): Promise<void> {
  const sshCmd = ["ssh", ...sshArgs(target)].join(" ");
  const r = await runCommand("rsync", [
    "-az",
    "--delete",
    "-e", sshCmd,
    `${localPath.replace(/\/?$/, "/")}`,
    `${target.ssh_user}@${target.ssh_host}:${remotePath.replace(/\/?$/, "/")}`,
  ]);
  if (r.code !== 0) {
    throw new Error(`rsync exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

async function verifyMeta(baseUrl: string, extName: string): Promise<string | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${extName}/_meta`;
  try {
    // Poll for up to 20 s while the hot-reload picks up the swap.
    for (let i = 0; i < 10; i++) {
      const r = await fetch(url);
      if (r.ok) {
        const body = (await r.json()) as { sourceCommit?: string };
        if (body?.sourceCommit) return body.sourceCommit;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
  } catch {
    return null;
  }
  return null;
}

export async function pushExtension(input: PushInput): Promise<PushResult> {
  const cfg = await loadTargets(input.targetsFile);
  const target = cfg.targets[input.target];
  if (!target) {
    throw new Error(`unknown target '${input.target}' — known: ${Object.keys(cfg.targets).join(", ") || "(none)"}`);
  }
  const repoRoot = resolve(input.repoRoot);
  const extDir = join(repoRoot, "extensions", input.extensionName);
  if (!existsSync(extDir)) {
    throw new Error(`no such extension: ${input.extensionName} (looked at ${extDir})`);
  }

  const sourceCommit = await resolveSourceCommit(repoRoot, input.extensionName);

  const buildStart = Date.now();
  if (!input.skipBuild) {
    await build(extDir);
  }
  const buildDurationMs = Date.now() - buildStart;

  const distPath = join(extDir, "dist");
  if (!existsSync(distPath)) {
    throw new Error(`no dist/ at ${distPath} — did the build succeed?`);
  }

  const remoteBase = target.remote_extensions_path.replace(/\/+$/, "");
  const remoteFinal = `${remoteBase}/${input.extensionName}/dist`;
  const remoteStage = `${remoteBase}/${input.extensionName}/dist_new`;

  const transportStart = Date.now();
  // Ensure the extension's home dir exists and is writable by the SSH user.
  await ssh(target, `mkdir -p ${remoteBase}/${input.extensionName} && rm -rf ${remoteStage}`);
  await rsyncToRemote(target, distPath, remoteStage);
  // Atomic swap: rename the old dist away, promote the new one, then remove the old.
  await ssh(
    target,
    `set -e; ` +
      `if [ -d ${remoteFinal} ]; then mv ${remoteFinal} ${remoteFinal}_prev; fi; ` +
      `mv ${remoteStage} ${remoteFinal}; ` +
      `rm -rf ${remoteFinal}_prev`,
  );
  const transportDurationMs = Date.now() - transportStart;

  const verifiedCommit = await verifyMeta(target.base_url, input.extensionName);

  return {
    extensionName: input.extensionName,
    target: input.target,
    sourceCommit,
    buildDurationMs,
    transportDurationMs,
    verifiedCommit,
  };
}

export interface StatusInput {
  target: string;
  targetsFile: string;
  extensions?: string[];  // if provided, only these
  repoRoot: string;
}

export interface ExtensionStatus {
  name: string;
  sourceCommit: string | null;
  buildTime: string | null;
  target: string;
  error?: string;
}

async function listExtensions(repoRoot: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(join(repoRoot, "extensions"));
  const out: string[] = [];
  for (const e of entries) {
    // Filter to entries that look like extensions (have a package.json).
    if (existsSync(join(repoRoot, "extensions", e, "package.json"))) out.push(e);
  }
  return out.sort();
}

export async function statusExtensions(input: StatusInput): Promise<ExtensionStatus[]> {
  const cfg = await loadTargets(input.targetsFile);
  const target = cfg.targets[input.target];
  if (!target) {
    throw new Error(`unknown target '${input.target}' — known: ${Object.keys(cfg.targets).join(", ") || "(none)"}`);
  }
  const names = input.extensions?.length
    ? input.extensions
    : await listExtensions(input.repoRoot);
  const out: ExtensionStatus[] = [];
  for (const name of names) {
    const url = `${target.base_url.replace(/\/+$/, "")}/${name}/_meta`;
    try {
      const r = await fetch(url);
      if (!r.ok) {
        out.push({ name, sourceCommit: null, buildTime: null, target: input.target, error: `HTTP ${r.status}` });
        continue;
      }
      const body = (await r.json()) as { sourceCommit?: unknown; buildTime?: unknown };
      out.push({
        name,
        sourceCommit: typeof body?.sourceCommit === "string" ? body.sourceCommit : null,
        buildTime: typeof body?.buildTime === "string" ? body.buildTime : null,
        target: input.target,
      });
    } catch (e) {
      out.push({ name, sourceCommit: null, buildTime: null, target: input.target, error: (e as Error).message });
    }
  }
  return out;
}
