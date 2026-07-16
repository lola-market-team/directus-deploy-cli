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

// -------------------- extensions diff --------------------
// Cross-env content-equivalence matrix. Compares the git *tree hash* of
// extensions/<name>/ at the deployed sourceCommit against the same path at
// the reference ref. Tree hash is git's own content-addressable identifier —
// same source tree = same tree hash, regardless of commit lineage. This
// sidesteps every branch/squash/history-rewrite pathology that the old
// SHA-ancestry check had:
//
//   - squash-merge orphans a branch's SHA; ancestry check reports "not on
//     ref" even though the SOURCE is byte-identical. Tree hash matches.
//   - "unpushed?" (SHA not on any remote branch) used to be indistinguishable
//     from "code lost." Tree hash resolves it: if the local objects exist,
//     we know whether the source matches ref regardless of push state.
//   - Default reference was origin/master; in a develop-first release train
//     everything integrated but not yet released showed as ✗. Default is now
//     origin/develop; --reference overrides.
//
// One HTTP call per (target, ext), one `git rev-parse <sha>:<path>` per
// unique (sha, ext) pair, one for reference. All local.

export interface DiffInput {
  targetsFile: string;
  extensions?: string[];  // if provided, only these
  targets?: string[];     // if provided, only these targets (default: every target in the file)
  repoRoot: string;
  reference: string;      // ref to compare content against, e.g. "origin/develop"
}

export interface DiffCell {
  target: string;
  sourceCommit: string | null;
  deployedTreeHash: string | null; // git tree hash of extensions/<name>/ at sourceCommit
  matchesReference: boolean;       // deployedTreeHash === referenceTreeHash for this ext
  branchHint: string | null;       // best-effort branch label when content differs (single branch if unambiguous)
  error?: string;
}

export interface DiffRow {
  extension: string;
  referenceTreeHash: string | null; // git tree hash of extensions/<name>/ at reference
  cells: Record<string, DiffCell>;  // target → cell
}

export interface DiffReport {
  reference: string;
  targets: string[];
  rows: DiffRow[];
}

// Returns the git tree hash of a path at a given ref (`git rev-parse <ref>:<path>`).
// Empty string if the object is missing (SHA not fetched, path doesn't exist).
async function gitTreeHash(repoRoot: string, ref: string, path: string): Promise<string | null> {
  // Trailing slash matters — git resolves `<ref>:extensions/foo/` to the tree,
  // `<ref>:extensions/foo` to the same tree, but only when it exists. Normalize.
  const target = `${ref}:${path.replace(/\/+$/, "")}`;
  const r = await runCommand("git", ["-C", repoRoot, "rev-parse", target]);
  if (r.code !== 0) return null;
  const line = r.stdout.trim().split("\n")[0]?.trim();
  return line && /^[0-9a-f]{40}$/.test(line) ? line : null;
}

// When content differs, we still want a hint about what's running. Prefer
// a branch that has EXACTLY the same tree hash for this ext — that identifies
// the WIP branch directly, without listing every branch that happens to
// contain the SHA in its history. Falls back to null when nothing matches.
async function branchHintForTreeHash(
  repoRoot: string,
  ext: string,
  treeHash: string,
  reference: string,
): Promise<string | null> {
  // List all remote branches; short-circuit on empty.
  const r = await runCommand("git", ["-C", repoRoot, "for-each-ref", "--format=%(refname)", "refs/remotes/"]);
  if (r.code !== 0) return null;
  const branches = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.endsWith("/HEAD") && s !== `refs/remotes/${reference.replace(/^origin\//, "origin/")}`);

  const path = `extensions/${ext}/src`;
  const matches: string[] = [];
  for (const ref of branches) {
    const h = await gitTreeHash(repoRoot, ref, path);
    if (h === treeHash) matches.push(ref.replace(/^refs\/remotes\//, ""));
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0]!;
  // Multiple branches share this tree — pick the shortest name (usually the
  // canonical one, e.g. feat/foo over user/copy-of-feat/foo).
  matches.sort((a, b) => a.length - b.length);
  return `${matches[0]} (+${matches.length - 1} more)`;
}

export async function diffExtensions(input: DiffInput): Promise<DiffReport> {
  const cfg = await loadTargets(input.targetsFile);
  const targetNames = input.targets?.length ? input.targets : Object.keys(cfg.targets);
  const missing = targetNames.filter((t) => !cfg.targets[t]);
  if (missing.length) {
    throw new Error(`unknown target(s): ${missing.join(", ")}`);
  }
  const names = input.extensions?.length
    ? input.extensions
    : await listExtensions(input.repoRoot);

  // Tree-hash cache — one lookup per (sha, ext) pair, reused across targets.
  // Compare `extensions/<ext>/src` (not the full folder): README, CHANGELOG,
  // and other non-code changes shouldn't flag content drift because they
  // don't ship to the built bundle. Consistent with build-info's stamp,
  // which computes sourceCommit from `git log -- src`.
  const treeHashCache = new Map<string, string | null>();
  const cachedTreeHash = async (ref: string, ext: string): Promise<string | null> => {
    const key = `${ref}::extensions/${ext}/src`;
    if (treeHashCache.has(key)) return treeHashCache.get(key)!;
    const h = await gitTreeHash(input.repoRoot, ref, `extensions/${ext}/src`);
    treeHashCache.set(key, h);
    return h;
  };

  const rows: DiffRow[] = [];
  for (const ext of names) {
    const referenceTreeHash = await cachedTreeHash(input.reference, ext);
    const row: DiffRow = { extension: ext, referenceTreeHash, cells: {} };

    for (const targetName of targetNames) {
      const target = cfg.targets[targetName]!;
      const url = `${target.base_url.replace(/\/+$/, "")}/${ext}/_meta`;
      let sourceCommit: string | null = null;
      let error: string | undefined;
      try {
        const r = await fetch(url);
        if (r.ok) {
          const body = (await r.json()) as { sourceCommit?: unknown };
          if (typeof body?.sourceCommit === "string") sourceCommit = body.sourceCommit;
        } else {
          error = `HTTP ${r.status}`;
        }
      } catch (e) {
        error = (e as Error).message;
      }

      let deployedTreeHash: string | null = null;
      let matchesReference = false;
      let branchHint: string | null = null;

      if (sourceCommit) {
        deployedTreeHash = await cachedTreeHash(sourceCommit, ext);
        if (deployedTreeHash && referenceTreeHash) {
          matchesReference = deployedTreeHash === referenceTreeHash;
        }
        if (deployedTreeHash && !matchesReference) {
          branchHint = await branchHintForTreeHash(input.repoRoot, ext, deployedTreeHash, input.reference);
        }
      }

      row.cells[targetName] = {
        target: targetName,
        sourceCommit,
        deployedTreeHash,
        matchesReference,
        branchHint,
        error,
      };
    }
    rows.push(row);
  }
  return { reference: input.reference, targets: targetNames, rows };
}

// Human-friendly renderer for a DiffReport. Compact matrix — one row per
// extension, one column per target, one final "state" summary.
export function renderDiff(report: DiffReport): string {
  const nameCol = Math.max(9, ...report.rows.map((r) => r.extension.length));
  const cellCol = 18;

  const header =
    "extension".padEnd(nameCol) +
    "  " +
    report.targets.map((t) => t.padEnd(cellCol)).join("") +
    "state";
  const sep = "─".repeat(header.length);
  const lines: string[] = [header, sep];

  const shortSha = (s: string | null): string => (s ? s.slice(0, 8) : "—       ");

  for (const row of report.rows) {
    const cells = report.targets.map((t) => {
      const cell = row.cells[t];
      if (!cell) return "?               ".padEnd(cellCol);
      if (cell.error) return `err: ${cell.error}`.padEnd(cellCol);
      if (!cell.sourceCommit) return "not deployed".padEnd(cellCol);
      // ✓ = source tree matches reference, ✗ = differs, ? = SHA not local (can't verify)
      const marker = cell.deployedTreeHash == null ? "?" : cell.matchesReference ? "✓" : "✗";
      return `${shortSha(cell.sourceCommit)} ${marker}`.padEnd(cellCol);
    });

    // Per-row state: aggregate across cells.
    const deployedCells = report.targets.map((t) => row.cells[t]).filter((c) => c?.sourceCommit);
    let state: string;
    if (deployedCells.length === 0) {
      state = "not deployed anywhere";
    } else if (deployedCells.every((c) => c!.matchesReference)) {
      state = `matches ${report.reference}`;
    } else if (deployedCells.some((c) => c!.deployedTreeHash == null)) {
      // Fetch first, then compare — some SHAs aren't local yet.
      const missing = deployedCells.filter((c) => c!.deployedTreeHash == null).length;
      state = `${missing} deployed SHA(s) not in local git — try 'git fetch --all'`;
    } else {
      // Which targets differ from reference? Note the branch hint per target.
      const off = report.targets
        .map((t) => ({ t, c: row.cells[t] }))
        .filter(({ c }) => c?.sourceCommit && !c.matchesReference && c.deployedTreeHash != null);
      const detail = off.map(({ t, c }) => {
        const hint = c!.branchHint ?? "orphaned (post-squash?)";
        return `${t}=${hint}`;
      });
      state = detail.join(" ");
    }

    lines.push(
      row.extension.padEnd(nameCol) + "  " + cells.join("") + state,
    );
  }

  lines.push("");
  lines.push(
    `legend: ✓ = source tree matches ${report.reference}   ✗ = differs   ? = deployed SHA not in local git`,
  );
  return lines.join("\n");
}
