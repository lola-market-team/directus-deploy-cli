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

import { loadTargets } from "./targets.js";
import type { TargetConfig, TargetsFile } from "./targets.js";
// Re-export so existing importers (cli, overview, mcp-server) keep working.
export { loadTargets } from "./targets.js";
export type { TargetConfig, TargetsFile } from "./targets.js";
import { callControl, resolveInvokerKey, resolveVmControl } from "./vm.js";
import { gcsDownload, gcsObjectExists, gcsUpload, mintGcsToken, parseGsUri } from "./gcloud.js";
import type { InvokerKey } from "./gcloud.js";

const DEFAULT_ARTIFACT_BUCKET = "gs://lola-market-extensions";

export interface PushInput {
  extensionName: string;
  target: string;
  targetsFile: string;
  repoRoot: string;
  skipBuild?: boolean;
  publish?: boolean;      // also upload the built tarball to gs://<bucket>/<name>/<sha>.tgz
  allowDirty?: boolean;   // permit dirty worktree when publishing (never for prod)
  force?: boolean;        // overwrite an existing artifact
}

export interface PushResult {
  extensionName: string;
  target: string;
  sourceCommit: string;
  buildDurationMs: number;
  transportDurationMs: number;
  verifiedCommit: string | null;
  artifact?: {
    uri: string;             // gs://<bucket>/<name>/<sha>.tgz
    sha256: string;
    alreadyPublished: boolean;
    uploadDurationMs: number;
  };
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
  // Match packages/build-info/bin/stamp-build-info.mjs — the stamper is the
  // source of truth for what ends up in /_meta.sourceCommit. Both scoped
  // to `src/` so non-src changes (package.json version bumps, dependency
  // updates, tests) don't produce a phantom expected-vs-stamped mismatch
  // that verifyMeta could never resolve — this was the actual bug behind
  // the "chokidar reload false-negative" theory (runs 29525123627,
  // 29523531092, 29524916438 on 2026-07-16).
  const r = await assertCommand(
    "git",
    [
      "-C",
      repoRoot,
      "log",
      "-1",
      "--format=%H",
      "--",
      `extensions/${extName}/src`,
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

// Two SHAs match if either is a prefix of the other. Handles the common
// full-vs-short (%H vs %h) length mismatch between git log callers and
// the build-info stamper.
export function shaMatch(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

async function verifyMeta(
  baseUrl: string,
  extName: string,
  expectedCommit?: string,
): Promise<string | null> {
  const url = `${baseUrl.replace(/\/+$/, "")}/${extName}/_meta`;
  // Poll for up to 60 s while chokidar picks up the atomic swap. Empirically
  // the hot-reload can take 15–30 s under load (larger bundles, cold VM),
  // and firing once at 20 s produces the false-negative pattern seen in run
  // 29525123627 (2026-07-16): /_meta reports the previous sourceCommit,
  // deploy is reported failed, then a manual re-probe 10 s later confirms
  // the new commit is live.
  //
  // If expectedCommit is provided, keep polling until /_meta reports it
  // (i.e. don't return early on the stale pre-reload value). Falls back to
  // returning the last-seen sourceCommit at timeout so the caller can
  // surface a real mismatch when the deploy actually didn't take.
  let lastSeen: string | null = null;
  const attempts = 20; // 20 × 3s = 60 s
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const body = (await r.json()) as { sourceCommit?: string };
        if (body?.sourceCommit) {
          lastSeen = body.sourceCommit;
          // Full-SHA (git log %H) vs short-SHA (%h from stamper): either
          // direction is a legitimate prefix match. Comparing only one way
          // was the actual bug — verifier "expected fcaa23ff (full)" and
          // /_meta reported "fcaa23ff (short)"; short.startsWith(long) was
          // always false, producing a phantom mismatch even when the deploy
          // was clean.
          if (!expectedCommit || shaMatch(body.sourceCommit, expectedCommit)) {
            return body.sourceCommit;
          }
        }
      }
    } catch {
      // network flake — keep trying
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return lastSeen;
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

  // Publish artifacts against the SAME short-sha convention as
  // scripts/build-extension.sh — that's what promote (and today's bash) look
  // up in the bucket. Refuse a dirty tree when publishing unless allowDirty:
  // an artifact for a commit that doesn't reflect the source tree is a lie
  // future promotes can't detect.
  let artifactSourceCommit: string | null = null;
  if (input.publish) {
    artifactSourceCommit = await resolveArtifactSourceCommit(repoRoot, input.extensionName);
    if (!input.allowDirty) {
      const dirty = await worktreeDirty(repoRoot, input.extensionName);
      if (dirty) {
        throw new Error(
          `refusing to publish ${input.extensionName}: source tree is dirty (pass --allow-dirty to override)\n${dirty}`,
        );
      }
    }
  }

  const buildStart = Date.now();
  let stamped = false;
  if (!input.skipBuild) {
    // Publishing: stamp build-info first so the running bundle reports the
    // exact commit the artifact filename claims. Push-only (no publish)
    // keeps today's behavior — the extension's own build step handles
    // stamping (or doesn't; it's a caller concern for non-publish flows).
    if (input.publish) {
      stamped = await stampBuildInfo(repoRoot, extDir);
    }
    try {
      await build(extDir);
    } finally {
      if (stamped) await restoreStampedFile(repoRoot, input.extensionName);
    }
  }
  const buildDurationMs = Date.now() - buildStart;

  const distPath = join(extDir, "dist");
  if (!existsSync(distPath)) {
    throw new Error(`no dist/ at ${distPath} — did the build succeed?`);
  }

  // Publish BEFORE rsync so a rsync failure doesn't leave a promoted-but-
  // untransported artifact. Alreadyexists → reuse (first-write-wins).
  let artifact: PushResult["artifact"] | undefined;
  if (input.publish) {
    const bucket = targetArtifactBucket(target);
    const uploadStart = Date.now();
    const r = await publishTarball({
      repoRoot,
      extName: input.extensionName,
      extDir,
      bucket,
      sourceCommit: artifactSourceCommit!,
      force: Boolean(input.force),
      gcsKey: resolveInvokerKey(input.target, target, process.env),
    });
    artifact = {
      uri: r.artifactUri,
      sha256: r.sha256,
      alreadyPublished: r.alreadyPublished,
      uploadDurationMs: Date.now() - uploadStart,
    };
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

  const verifiedCommit = await verifyMeta(target.base_url, input.extensionName, sourceCommit);

  return {
    extensionName: input.extensionName,
    target: input.target,
    sourceCommit,
    buildDurationMs,
    transportDurationMs,
    verifiedCommit,
    artifact,
  };
}

// -------------------- artifact publish / promote --------------------
// build-once/promote-many. `push --publish` uploads the built tarball to
// gs://<bucket>/<name>/<short-sha>.tgz alongside a .sha256 sidecar; `promote`
// resolves the SAME short-sha for the current source tree and pulls THAT
// exact tarball to the target VM. Prod never builds — it only promotes.
//
// The short-SHA + scoped source commit convention is deliberately identical
// to scripts/build-extension.sh so today's published artifacts stay
// resolvable by whichever tool a caller happens to use.

async function resolveArtifactSourceCommit(
  repoRoot: string,
  extName: string,
): Promise<string> {
  // Match scripts/build-extension.sh: last commit touching extensions/<name>/,
  // EXCLUDING dist/ (build output) and the stamped build-info placeholder.
  // Short (%h) — that's what the artifact filename uses in the bucket.
  const r = await assertCommand(
    "git",
    [
      "-C",
      repoRoot,
      "log",
      "-1",
      "--format=%h",
      "--",
      `extensions/${extName}`,
      `:!extensions/${extName}/dist`,
      `:!extensions/${extName}/src/build-info.ts`,
    ],
    { label: "git log artifact source commit" },
  );
  const commit = r.stdout.trim();
  if (!commit) throw new Error(`could not resolve artifact source commit for ${extName}`);
  return commit;
}

async function worktreeDirty(repoRoot: string, extName: string): Promise<string> {
  // Uncommitted changes under the extension, excluding dist/ + build-info.ts.
  // Same scope as build-extension.sh's --allow-dirty check.
  const r = await runCommand("git", [
    "-C",
    repoRoot,
    "status",
    "--porcelain",
    "--",
    `extensions/${extName}`,
    `:!extensions/${extName}/dist`,
    `:!extensions/${extName}/src/build-info.ts`,
  ]);
  return r.code === 0 ? r.stdout.trim() : "";
}

async function stampBuildInfo(repoRoot: string, extDir: string): Promise<boolean> {
  // Repo-owned stamper (packages/build-info/bin/stamp-build-info.mjs) writes
  // the sourceCommit that ends up in /_meta. If it exists, run it before
  // build so the artifact's stamped commit matches its filename. Missing
  // stamper is not an error — some repos don't use build-info.
  const stamper = join(repoRoot, "packages", "build-info", "bin", "stamp-build-info.mjs");
  if (!existsSync(stamper)) return false;
  await assertCommand("node", [stamper, extDir], { label: `stamp-build-info ${extDir}` });
  return true;
}

async function restoreStampedFile(repoRoot: string, extName: string): Promise<void> {
  // Restore the committed dev placeholder after build. Tolerate a not-yet-
  // committed file (fresh extension).
  const file = `extensions/${extName}/src/build-info.ts`;
  await runCommand("git", ["-C", repoRoot, "checkout", "--", file]);
}

function targetArtifactBucket(target: TargetConfig): string {
  return (target.artifact_bucket ?? DEFAULT_ARTIFACT_BUCKET).replace(/\/+$/, "");
}

async function gsutilStatExists(uri: string): Promise<boolean> {
  const r = await runCommand("gsutil", ["-q", "stat", uri]);
  return r.code === 0;
}

async function gsutilAvailable(): Promise<boolean> {
  try {
    const r = await runCommand("gsutil", ["version"]);
    return r.code === 0;
  } catch {
    return false; // spawn ENOENT — binary not installed (agent sandboxes)
  }
}

async function publishTarball(input: {
  repoRoot: string;
  extName: string;
  extDir: string;
  bucket: string;
  sourceCommit: string;
  force: boolean;
  gcsKey?: InvokerKey; // REST fallback when gsutil is unavailable (agent sandboxes)
}): Promise<{ artifactUri: string; sha256: string; alreadyPublished: boolean }> {
  const { repoRoot, extName, extDir, bucket, sourceCommit, force, gcsKey } = input;
  const artifactUri = `${bucket}/${extName}/${sourceCommit}.tgz`;

  const viaGsutil = await gsutilAvailable();
  let gcsToken: string | undefined;
  let bucketName = "";
  if (!viaGsutil) {
    if (!gcsKey) {
      throw new Error(
        "cannot publish: gsutil is not installed and no invoker SA key is available (set DIRECTUS_<TARGET>_INVOKER_KEY_B64 with storage access)",
      );
    }
    gcsToken = await mintGcsToken(gcsKey);
    bucketName = parseGsUri(bucket).bucket;
  }
  const objectName = `${extName}/${sourceCommit}.tgz`;

  const exists = viaGsutil
    ? await gsutilStatExists(artifactUri)
    : await gcsObjectExists(bucketName, objectName, gcsToken!);
  if (!force && exists) {
    // First-write-wins. The existing artifact is authoritative: rebuild + reupload
    // would break the byte-identity guarantee across envs.
    // Best-effort sha lookup from the sidecar; empty string if missing.
    let sha = "";
    if (viaGsutil) {
      const r = await runCommand("gsutil", ["cat", `${artifactUri}.sha256`]);
      sha = r.code === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? "") : "";
    } else {
      const sidecar = await gcsDownload(bucketName, `${objectName}.sha256`, gcsToken!);
      sha = sidecar ? (sidecar.toString("utf8").trim().split(/\s+/)[0] ?? "") : "";
    }
    return { artifactUri, sha256: sha, alreadyPublished: true };
  }

  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const stage = await mkdtemp(join(tmpdir(), `dd-artifact-${extName}-`));
  const tarball = join(stage, `${sourceCommit}.tgz`);

  // COPYFILE_DISABLE + --no-mac-metadata strip Darwin's AppleDouble headers
  // so GNU tar on the VM doesn't spew "Ignoring unknown extended header
  // keyword" warnings on extract. Matches scripts/build-extension.sh.
  const isDarwin = process.platform === "darwin";
  const tarArgs = ["-C", extDir];
  if (isDarwin) tarArgs.push("--no-mac-metadata");
  tarArgs.push("-cf", "-", "dist", "package.json");

  // tar → gzip → file. Two-child pipeline; keep it simple with shell.
  const cmd = `COPYFILE_DISABLE=1 tar ${tarArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} | gzip -n > '${tarball.replace(/'/g, "'\\''")}'`;
  const rTar = await runCommand("sh", ["-c", cmd]);
  if (rTar.code !== 0) {
    throw new Error(`tar/gzip failed: ${rTar.stderr.trim() || rTar.stdout.trim()}`);
  }

  // sha256 (uses shasum on macOS, sha256sum on Linux).
  const shaBin = isDarwin ? "shasum" : "sha256sum";
  const shaArgs = isDarwin ? ["-a", "256", tarball] : [tarball];
  const rSha = await assertCommand(shaBin, shaArgs, { label: `sha256 ${tarball}` });
  const sha = rSha.stdout.trim().split(/\s+/)[0] ?? "";
  if (!sha) throw new Error(`could not compute sha256 for ${tarball}`);
  const shaFile = `${tarball}.sha256`;
  await writeFile(shaFile, `${sha}  ${extName}/${sourceCommit}.tgz\n`, "utf8");

  // Upload atomically-adjacent (tarball first, sha256 second). Race window:
  // a promoter reading between the two uploads gets the tarball without the
  // sidecar — promote code tolerates missing sha256 (best-effort verify).
  if (viaGsutil) {
    await assertCommand("gsutil", ["-q", "cp", tarball, artifactUri], {
      label: `gsutil cp → ${artifactUri}`,
    });
    await assertCommand("gsutil", ["-q", "cp", shaFile, `${artifactUri}.sha256`], {
      label: `gsutil cp → ${artifactUri}.sha256`,
    });
  } else {
    const { readFile: read } = await import("node:fs/promises");
    await gcsUpload(bucketName, objectName, await read(tarball), gcsToken!, "application/gzip");
    await gcsUpload(bucketName, `${objectName}.sha256`, await read(shaFile), gcsToken!, "text/plain");
  }

  return { artifactUri, sha256: sha, alreadyPublished: false };
}

export interface PromoteInput {
  extensionName: string;
  target: string;
  targetsFile: string;
  repoRoot: string;
  sourceCommit?: string;  // override the resolved short-sha (promote a specific historical artifact)
  via?: "ssh" | "control"; // transport: direct SSH (default) or the target's control_url function
}

export interface PromoteResult {
  extensionName: string;
  target: string;
  sourceCommit: string;
  artifactUri: string;
  transportDurationMs: number;
  verifiedCommit: string | null;
}

export async function promoteExtension(input: PromoteInput): Promise<PromoteResult> {
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

  const sourceCommit =
    input.sourceCommit ?? (await resolveArtifactSourceCommit(repoRoot, input.extensionName));
  const bucket = targetArtifactBucket(target);
  const artifactUri = `${bucket}/${input.extensionName}/${sourceCommit}.tgz`;

  // Control transport: the target's vm-control function runs the identical
  // install script over SSH from inside GCP. Used where the caller has no
  // SSH egress (agent sandboxes). Artifact existence is verified via GCS REST
  // when an invoker key is available; the remote install re-verifies sha256.
  if (input.via === "control") {
    const ctl = resolveVmControl(input.target, target, process.env);
    if (ctl.invokerKey) {
      const token = await mintGcsToken(ctl.invokerKey);
      const { bucket: bucketName } = parseGsUri(bucket);
      if (!(await gcsObjectExists(bucketName, `${input.extensionName}/${sourceCommit}.tgz`, token))) {
        throw new Error(
          `no artifact at ${artifactUri} — publish first: directus-deploy extensions push ${input.extensionName} --target <build-env> --publish`,
        );
      }
    }
    const transportStart = Date.now();
    await callControl(ctl, "deploy", { name: input.extensionName, sha: sourceCommit });
    const transportDurationMs = Date.now() - transportStart;
    const verifiedCommit = await verifyMeta(target.base_url, input.extensionName, sourceCommit);
    return {
      extensionName: input.extensionName,
      target: input.target,
      sourceCommit,
      artifactUri,
      transportDurationMs,
      verifiedCommit,
    };
  }

  if (!(await gsutilStatExists(artifactUri))) {
    // Prod-like targets never build — the artifact must already exist,
    // proving it was validated on a lower env for the same source commit.
    const hint = target.build_forbidden
      ? `\n  ${input.target} is build-forbidden — promote a commit already published to a lower env, or publish first: directus-deploy extensions push ${input.extensionName} --target <lower-env> --publish`
      : `\n  publish it first: directus-deploy extensions push ${input.extensionName} --target <build-env> --publish`;
    throw new Error(`no artifact at ${artifactUri}${hint}`);
  }

  const remoteBase = target.remote_extensions_path.replace(/\/+$/, "");
  const remoteExt = `${remoteBase}/${input.extensionName}`;

  const transportStart = Date.now();
  // Fetch + verify + unpack + install per-file — chokidar hot-reload watches
  // per-file inodes, so a full dist/ dir-swap changes the dist inode and the
  // watch never fires (see comments in scripts/deploy-extension.sh). Per-file
  // mv-in-place is atomic AND chokidar-friendly. VMs have gsutil (prod
  // backup cron uses it).
  await ssh(
    target,
    `set -e; ` +
      `mkdir -p ${remoteExt}/dist; ` +
      `TMPDIR=$(mktemp -d); ` +
      `gsutil -q cp '${artifactUri}' "$TMPDIR/artifact.tgz"; ` +
      `gsutil -q cp '${artifactUri}.sha256' "$TMPDIR/artifact.sha256" || true; ` +
      `if [ -s "$TMPDIR/artifact.sha256" ]; then ` +
      `  want=$(awk '{print $1}' "$TMPDIR/artifact.sha256"); ` +
      `  got=$(sha256sum "$TMPDIR/artifact.tgz" | awk '{print $1}'); ` +
      `  if [ "$want" != "$got" ]; then echo "sha256 mismatch: want $want got $got" >&2; exit 1; fi; ` +
      `fi; ` +
      `tar -C "$TMPDIR" -xzf "$TMPDIR/artifact.tgz"; ` +
      // Per-file atomic mv into dist/. Stale files (removed from the artifact
      // between builds) are cleared first so a shrinking bundle doesn't leave
      // orphaned entry-points behind.
      `find ${remoteExt}/dist -maxdepth 1 -type f -name '*.js' -delete; ` +
      `for f in "$TMPDIR"/dist/*.js; do ` +
      `  base=$(basename "$f"); ` +
      `  cp "$f" "${remoteExt}/dist/.$base.new"; ` +
      `  mv "${remoteExt}/dist/.$base.new" "${remoteExt}/dist/$base"; ` +
      `done; ` +
      // package.json lives in the extension root (bundle-entry discovery).
      `if [ -f "$TMPDIR/package.json" ]; then ` +
      `  cp "$TMPDIR/package.json" "${remoteExt}/package.json.new"; ` +
      `  mv "${remoteExt}/package.json.new" "${remoteExt}/package.json"; ` +
      `fi; ` +
      `rm -rf "$TMPDIR"`,
  );
  const transportDurationMs = Date.now() - transportStart;

  const verifiedCommit = await verifyMeta(target.base_url, input.extensionName, sourceCommit);

  return {
    extensionName: input.extensionName,
    target: input.target,
    sourceCommit,
    artifactUri,
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
