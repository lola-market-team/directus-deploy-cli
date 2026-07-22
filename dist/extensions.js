import { spawn } from "node:child_process";
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
import { loadTargets, resolveAdminToken } from "./targets.js";
// Re-export so existing importers (cli, overview, mcp-server) keep working.
export { loadTargets } from "./targets.js";
import { callControl, resolveInvokerKey, resolveVmControl } from "./vm.js";
import { gcsDownload, gcsObjectExists, gcsUpload, mintGcsToken, parseGsUri } from "./gcloud.js";
const DEFAULT_ARTIFACT_BUCKET = "gs://lola-market-extensions";
function runCommand(cmd, args, opts = {}) {
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
async function assertCommand(cmd, args, opts = {}) {
    const r = await runCommand(cmd, args, opts);
    if (r.code !== 0) {
        const label = opts.label ?? `${cmd} ${args.join(" ")}`;
        throw new Error(`${label} exited ${r.code}: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r;
}
async function resolveSourceCommit(repoRoot, extName) {
    // Match packages/build-info/bin/stamp-build-info.mjs — the stamper is the
    // source of truth for what ends up in /_meta.sourceCommit. Both scoped
    // to `src/` so non-src changes (package.json version bumps, dependency
    // updates, tests) don't produce a phantom expected-vs-stamped mismatch
    // that verifyMeta could never resolve — this was the actual bug behind
    // the "chokidar reload false-negative" theory (runs 29525123627,
    // 29523531092, 29524916438 on 2026-07-16).
    const r = await assertCommand("git", [
        "-C",
        repoRoot,
        "log",
        "-1",
        "--format=%H",
        "--",
        `extensions/${extName}/src`,
    ], { label: "git log source commit" });
    const commit = r.stdout.trim();
    if (!commit)
        throw new Error(`could not resolve source commit for ${extName}`);
    return commit;
}
async function build(extDir) {
    // Assume workspace deps already installed at the repo root. If node_modules/.bin
    // is missing in the extension dir, install it.
    const hasBin = existsSync(join(extDir, "node_modules", ".bin", "directus-extension"));
    if (!hasBin) {
        await assertCommand("npm", ["ci"], { cwd: extDir, label: `npm ci ${extDir}` });
    }
    await assertCommand("npm", ["run", "build"], { cwd: extDir, label: `npm run build ${extDir}` });
}
function sshArgs(target, extraOpts = []) {
    const keyPath = target.ssh_key_env
        ? process.env[target.ssh_key_env]
        : process.env.LOLA_EXT_SSH_KEY;
    const args = [];
    if (keyPath)
        args.push("-i", keyPath);
    args.push("-o", "StrictHostKeyChecking=no", "-o", "IdentitiesOnly=yes", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR", ...extraOpts);
    return args;
}
async function ssh(target, remoteCmd) {
    const args = [...sshArgs(target), `${target.ssh_user}@${target.ssh_host}`, remoteCmd];
    const r = await assertCommand("ssh", args, { label: `ssh: ${remoteCmd.slice(0, 60)}` });
    return r.stdout;
}
async function rsyncToRemote(target, localPath, remotePath) {
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
export function shaMatch(a, b) {
    return a.startsWith(b) || b.startsWith(a);
}
async function verifyMeta(baseUrl, extName, expectedCommit) {
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
    let lastSeen = null;
    const attempts = 20; // 20 × 3s = 60 s
    for (let i = 0; i < attempts; i++) {
        try {
            const r = await fetch(url);
            if (r.ok) {
                const body = (await r.json());
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
        }
        catch {
            // network flake — keep trying
        }
        await new Promise((res) => setTimeout(res, 3000));
    }
    return lastSeen;
}
export async function pushExtension(input) {
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
    let artifactSourceCommit = null;
    if (input.publish) {
        artifactSourceCommit = await resolveArtifactSourceCommit(repoRoot, input.extensionName);
        if (!input.allowDirty) {
            const dirty = await worktreeDirty(repoRoot, input.extensionName);
            if (dirty) {
                throw new Error(`refusing to publish ${input.extensionName}: source tree is dirty (pass --allow-dirty to override)\n${dirty}`);
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
        }
        finally {
            if (stamped)
                await restoreStampedFile(repoRoot, input.extensionName);
        }
    }
    const buildDurationMs = Date.now() - buildStart;
    const distPath = join(extDir, "dist");
    if (!existsSync(distPath)) {
        throw new Error(`no dist/ at ${distPath} — did the build succeed?`);
    }
    // Publish BEFORE rsync so a rsync failure doesn't leave a promoted-but-
    // untransported artifact. Alreadyexists → reuse (first-write-wins).
    let artifact;
    if (input.publish) {
        const bucket = targetArtifactBucket(target);
        const uploadStart = Date.now();
        const r = await publishTarball({
            repoRoot,
            extName: input.extensionName,
            extDir,
            bucket,
            sourceCommit: artifactSourceCommit,
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
    // API transport (body mode): POST the tarball straight to the target's
    // ext-deploy endpoint — Directus admin token auth, sha256 verified server-
    // side, per-file atomic install. Contract pinned on backend #378/#379.
    if (input.via === "api") {
        const token = resolveAdminToken(input.target, target, process.env);
        const { readFile: read } = await import("node:fs/promises");
        const { tarball, sha256 } = await createArtifactTarball(input.extensionName, extDir, (artifactSourceCommit ?? sourceCommit).slice(0, 12));
        const transportStart = Date.now();
        const url = `${target.base_url.replace(/\/+$/, "")}/ext-deploy/`;
        // The endpoint writes files BEFORE replying, and the extension hot-reload
        // it triggers can kill the connection mid-response (observed as a gateway
        // 502, or a dropped socket). So a failed response doesn't mean a failed
        // deploy — for those cases, probe /_meta for the expected commit before
        // declaring failure.
        let r = null;
        try {
            r = await fetch(url, {
                method: "POST",
                headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: input.extensionName,
                    sha256,
                    tarball: (await read(tarball)).toString("base64"),
                }),
            });
        }
        catch {
            r = null;
        }
        if (r === null || r.status === 502 || r.status === 503) {
            const probed = await verifyMeta(target.base_url, input.extensionName, sourceCommit);
            if (probed && shaMatch(probed, sourceCommit)) {
                return {
                    extensionName: input.extensionName,
                    target: input.target,
                    sourceCommit,
                    buildDurationMs,
                    transportDurationMs: Date.now() - transportStart,
                    verifiedCommit: probed,
                    artifact,
                };
            }
            if (r === null)
                throw new Error(`ext-deploy POST failed: connection dropped and /_meta does not report ${sourceCommit.slice(0, 12)}`);
        }
        if (!r.ok) {
            const body = await r.text().catch(() => "");
            // Two distinct 404s: Directus's router 404 ("Route ... doesn't exist")
            // means the request never reached ext-deploy (endpoint not installed,
            // or a URL-shape mismatch — the 0.21.0–0.22.2 bug); the endpoint's own
            // {"error":"not found"} means it ran but no deploy mode is enabled.
            const hint = r.status === 404
                ? /doesn't exist/i.test(body)
                    ? " (Directus router 404 — ext-deploy extension not installed on target, or CLI/server URL mismatch)"
                    : " (ext-deploy is installed but disabled: body mode requires EXT_DEPLOY_MODE=body on the target)"
                : r.status === 403
                    ? " (token is not admin)"
                    : "";
            throw new Error(`ext-deploy POST failed: HTTP ${r.status}${hint} ${body.slice(0, 300)}`);
        }
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
    // Control transport: the artifact is in the bucket; install it through the
    // target's control function (same install script, SSH executed inside GCP)
    // and verify /_meta. No SSH leaves this process.
    if (input.via === "control") {
        const ctl = resolveVmControl(input.target, target, process.env);
        const transportStart = Date.now();
        await callControl(ctl, "deploy", { name: input.extensionName, sha: artifactSourceCommit });
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
    const remoteBase = target.remote_extensions_path.replace(/\/+$/, "");
    const remoteFinal = `${remoteBase}/${input.extensionName}/dist`;
    const remoteStage = `${remoteBase}/${input.extensionName}/dist_new`;
    const transportStart = Date.now();
    // Ensure the extension's home dir exists and is writable by the SSH user.
    await ssh(target, `mkdir -p ${remoteBase}/${input.extensionName} && rm -rf ${remoteStage}`);
    await rsyncToRemote(target, distPath, remoteStage);
    // Atomic swap: rename the old dist away, promote the new one, then remove the old.
    await ssh(target, `set -e; ` +
        `if [ -d ${remoteFinal} ]; then mv ${remoteFinal} ${remoteFinal}_prev; fi; ` +
        `mv ${remoteStage} ${remoteFinal}; ` +
        `rm -rf ${remoteFinal}_prev`);
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
async function resolveArtifactSourceCommit(repoRoot, extName) {
    // Match scripts/build-extension.sh: last commit touching extensions/<name>/,
    // EXCLUDING dist/ (build output) and the stamped build-info placeholder.
    // Short (%h) — that's what the artifact filename uses in the bucket.
    const r = await assertCommand("git", [
        "-C",
        repoRoot,
        "log",
        "-1",
        "--format=%h",
        "--",
        `extensions/${extName}`,
        `:!extensions/${extName}/dist`,
        `:!extensions/${extName}/src/build-info.ts`,
    ], { label: "git log artifact source commit" });
    const commit = r.stdout.trim();
    if (!commit)
        throw new Error(`could not resolve artifact source commit for ${extName}`);
    return commit;
}
async function worktreeDirty(repoRoot, extName) {
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
async function stampBuildInfo(repoRoot, extDir) {
    // Repo-owned stamper (packages/build-info/bin/stamp-build-info.mjs) writes
    // the sourceCommit that ends up in /_meta. If it exists, run it before
    // build so the artifact's stamped commit matches its filename. Missing
    // stamper is not an error — some repos don't use build-info.
    const stamper = join(repoRoot, "packages", "build-info", "bin", "stamp-build-info.mjs");
    if (!existsSync(stamper))
        return false;
    await assertCommand("node", [stamper, extDir], { label: `stamp-build-info ${extDir}` });
    return true;
}
async function restoreStampedFile(repoRoot, extName) {
    // Restore the committed dev placeholder after build. Tolerate a not-yet-
    // committed file (fresh extension).
    const file = `extensions/${extName}/src/build-info.ts`;
    await runCommand("git", ["-C", repoRoot, "checkout", "--", file]);
}
function targetArtifactBucket(target) {
    return (target.artifact_bucket ?? DEFAULT_ARTIFACT_BUCKET).replace(/\/+$/, "");
}
async function gsutilStatExists(uri) {
    const r = await runCommand("gsutil", ["-q", "stat", uri]);
    return r.code === 0;
}
async function gsutilAvailable() {
    try {
        const r = await runCommand("gsutil", ["version"]);
        return r.code === 0;
    }
    catch {
        return false; // spawn ENOENT — binary not installed (agent sandboxes)
    }
}
// Build the artifact tarball for an extension. Constraints come from the
// ext-deploy endpoint's minimal tar reader (backend #379/#383):
//   - plain USTAR (--format=ustar; bsdtar defaults to PAX, GNU tar to GNU)
//   - FILE entries only: package.json + dist/*.js named explicitly, so no
//     directory entries, no symlinks, nothing recursive sneaks in
// COPYFILE_DISABLE + --no-mac-metadata strip Darwin AppleDouble noise.
async function createArtifactTarball(extName, extDir, sourceCommit) {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const stage = await mkdtemp(join(tmpdir(), `dd-artifact-${extName}-`));
    const tarball = join(stage, `${sourceCommit}.tgz`);
    const isDarwin = process.platform === "darwin";
    const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    const macFlag = isDarwin ? "--no-mac-metadata " : "";
    // dist/*.js expanded by the shell → explicit file entries only.
    const cmd = `cd ${q(extDir)} && COPYFILE_DISABLE=1 tar --format=ustar ${macFlag}-cf - package.json dist/*.js | gzip -n > ${q(tarball)}`;
    const rTar = await runCommand("sh", ["-c", cmd]);
    if (rTar.code !== 0) {
        throw new Error(`tar/gzip failed: ${rTar.stderr.trim() || rTar.stdout.trim()}`);
    }
    const shaBin = isDarwin ? "shasum" : "sha256sum";
    const shaArgs = isDarwin ? ["-a", "256", tarball] : [tarball];
    const rSha = await assertCommand(shaBin, shaArgs, { label: `sha256 ${tarball}` });
    const sha256 = rSha.stdout.trim().split(/\s+/)[0] ?? "";
    if (!sha256)
        throw new Error(`could not compute sha256 for ${tarball}`);
    return { tarball, sha256 };
}
async function publishTarball(input) {
    const { repoRoot, extName, extDir, bucket, sourceCommit, force, gcsKey } = input;
    const artifactUri = `${bucket}/${extName}/${sourceCommit}.tgz`;
    const viaGsutil = await gsutilAvailable();
    let gcsToken;
    let bucketName = "";
    if (!viaGsutil) {
        if (!gcsKey) {
            throw new Error("cannot publish: gsutil is not installed and no invoker SA key is available (set DIRECTUS_<TARGET>_INVOKER_KEY_B64 with storage access)");
        }
        gcsToken = await mintGcsToken(gcsKey);
        bucketName = parseGsUri(bucket).bucket;
    }
    const objectName = `${extName}/${sourceCommit}.tgz`;
    const exists = viaGsutil
        ? await gsutilStatExists(artifactUri)
        : await gcsObjectExists(bucketName, objectName, gcsToken);
    if (!force && exists) {
        // First-write-wins. The existing artifact is authoritative: rebuild + reupload
        // would break the byte-identity guarantee across envs.
        // Best-effort sha lookup from the sidecar; empty string if missing.
        let sha = "";
        if (viaGsutil) {
            const r = await runCommand("gsutil", ["cat", `${artifactUri}.sha256`]);
            sha = r.code === 0 ? (r.stdout.trim().split(/\s+/)[0] ?? "") : "";
        }
        else {
            const sidecar = await gcsDownload(bucketName, `${objectName}.sha256`, gcsToken);
            sha = sidecar ? (sidecar.toString("utf8").trim().split(/\s+/)[0] ?? "") : "";
        }
        return { artifactUri, sha256: sha, alreadyPublished: true };
    }
    const { writeFile } = await import("node:fs/promises");
    const { tarball, sha256: sha } = await createArtifactTarball(extName, extDir, sourceCommit);
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
    }
    else {
        const { readFile: read } = await import("node:fs/promises");
        await gcsUpload(bucketName, objectName, await read(tarball), gcsToken, "application/gzip");
        await gcsUpload(bucketName, `${objectName}.sha256`, await read(shaFile), gcsToken, "text/plain");
    }
    return { artifactUri, sha256: sha, alreadyPublished: false };
}
export async function promoteExtension(input) {
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
    const sourceCommit = input.sourceCommit ?? (await resolveArtifactSourceCommit(repoRoot, input.extensionName));
    const bucket = targetArtifactBucket(target);
    const artifactUri = `${bucket}/${input.extensionName}/${sourceCommit}.tgz`;
    // API transport (gcs mode, backend #382/#383): deploy-by-reference. POST
    // {name, sourceCommit} to the target's ext-deploy endpoint; the endpoint
    // itself pulls gs://…/<name>/<commit>.tgz via the VM's ambient identity and
    // installs. The admin token can only choose among already-published
    // artifacts — no code travels in the request.
    if (input.via === "api") {
        const token = resolveAdminToken(input.target, target, process.env);
        // Fail fast client-side when we CAN check the bucket (gsutil on laptops);
        // otherwise the endpoint 400s with a clear message.
        if (await gsutilAvailable()) {
            if (!(await gsutilStatExists(artifactUri))) {
                throw new Error(`no artifact at ${artifactUri} — publish first: directus-deploy extensions push ${input.extensionName} --target test --via control (or --publish)`);
            }
        }
        const transportStart = Date.now();
        const url = `${target.base_url.replace(/\/+$/, "")}/ext-deploy/`;
        const r = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                // Required when the target sets EXT_DEPLOY_REQUIRE_CONFIRM=true (prod);
                // harmless elsewhere. Echoes the exact name:commit being deployed.
                "X-Deploy-Confirm": `${input.extensionName}:${sourceCommit}`,
            },
            body: JSON.stringify({
                name: input.extensionName,
                sourceCommit,
                ...(input.force ? { force: true } : {}),
            }),
        });
        if (!r.ok) {
            const body = await r.text().catch(() => "");
            const hint = r.status === 409
                ? " — downgrade guard: the referenced artifact is older than what's installed; re-run with --force to override"
                : r.status === 404
                    ? " (ext-deploy gcs mode not enabled on this target?)"
                    : r.status === 403
                        ? " (token is not admin)"
                        : "";
            throw new Error(`ext-deploy promote failed: HTTP ${r.status}${hint} ${body.slice(0, 300)}`);
        }
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
                throw new Error(`no artifact at ${artifactUri} — publish first: directus-deploy extensions push ${input.extensionName} --target <build-env> --publish`);
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
    await ssh(target, `set -e; ` +
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
        `rm -rf "$TMPDIR"`);
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
async function listExtensions(repoRoot) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(join(repoRoot, "extensions"));
    const out = [];
    for (const e of entries) {
        // Filter to entries that look like extensions (have a package.json).
        if (existsSync(join(repoRoot, "extensions", e, "package.json")))
            out.push(e);
    }
    return out.sort();
}
export async function statusExtensions(input) {
    const cfg = await loadTargets(input.targetsFile);
    const target = cfg.targets[input.target];
    if (!target) {
        throw new Error(`unknown target '${input.target}' — known: ${Object.keys(cfg.targets).join(", ") || "(none)"}`);
    }
    const names = input.extensions?.length
        ? input.extensions
        : await listExtensions(input.repoRoot);
    const out = [];
    for (const name of names) {
        const url = `${target.base_url.replace(/\/+$/, "")}/${name}/_meta`;
        try {
            const r = await fetch(url);
            if (!r.ok) {
                out.push({ name, sourceCommit: null, buildTime: null, target: input.target, error: `HTTP ${r.status}` });
                continue;
            }
            const body = (await r.json());
            out.push({
                name,
                sourceCommit: typeof body?.sourceCommit === "string" ? body.sourceCommit : null,
                buildTime: typeof body?.buildTime === "string" ? body.buildTime : null,
                target: input.target,
            });
        }
        catch (e) {
            out.push({ name, sourceCommit: null, buildTime: null, target: input.target, error: e.message });
        }
    }
    return out;
}
// Returns the git tree hash of a path at a given ref (`git rev-parse <ref>:<path>`).
// Empty string if the object is missing (SHA not fetched, path doesn't exist).
async function gitTreeHash(repoRoot, ref, path) {
    // Trailing slash matters — git resolves `<ref>:extensions/foo/` to the tree,
    // `<ref>:extensions/foo` to the same tree, but only when it exists. Normalize.
    const target = `${ref}:${path.replace(/\/+$/, "")}`;
    const r = await runCommand("git", ["-C", repoRoot, "rev-parse", target]);
    if (r.code !== 0)
        return null;
    const line = r.stdout.trim().split("\n")[0]?.trim();
    return line && /^[0-9a-f]{40}$/.test(line) ? line : null;
}
// When content differs, we still want a hint about what's running. Prefer
// a branch that has EXACTLY the same tree hash for this ext — that identifies
// the WIP branch directly, without listing every branch that happens to
// contain the SHA in its history. Falls back to null when nothing matches.
async function branchHintForTreeHash(repoRoot, ext, treeHash, reference) {
    // List all remote branches; short-circuit on empty.
    const r = await runCommand("git", ["-C", repoRoot, "for-each-ref", "--format=%(refname)", "refs/remotes/"]);
    if (r.code !== 0)
        return null;
    const branches = r.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.endsWith("/HEAD") && s !== `refs/remotes/${reference.replace(/^origin\//, "origin/")}`);
    const path = `extensions/${ext}/src`;
    const matches = [];
    for (const ref of branches) {
        const h = await gitTreeHash(repoRoot, ref, path);
        if (h === treeHash)
            matches.push(ref.replace(/^refs\/remotes\//, ""));
    }
    if (matches.length === 0)
        return null;
    if (matches.length === 1)
        return matches[0];
    // Multiple branches share this tree — pick the shortest name (usually the
    // canonical one, e.g. feat/foo over user/copy-of-feat/foo).
    matches.sort((a, b) => a.length - b.length);
    return `${matches[0]} (+${matches.length - 1} more)`;
}
export async function diffExtensions(input) {
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
    const treeHashCache = new Map();
    const cachedTreeHash = async (ref, ext) => {
        const key = `${ref}::extensions/${ext}/src`;
        if (treeHashCache.has(key))
            return treeHashCache.get(key);
        const h = await gitTreeHash(input.repoRoot, ref, `extensions/${ext}/src`);
        treeHashCache.set(key, h);
        return h;
    };
    // Deployed stamps reference arbitrary history: a stale or shallow clone
    // (sandboxed agents) can't resolve older SHAs, and squash-merges orphan
    // branch SHAs outright. One recovery fetch per run repairs the first two
    // cases; a SHA that still doesn't resolve becomes an error cell — never
    // silent drift. Fetching by SHA directly is not an option: stamps are
    // short SHAs and fetch wants require full 40-char ids.
    let recoveryFetched = false;
    const recoverMissingObjects = async () => {
        if (recoveryFetched)
            return;
        recoveryFetched = true;
        await runCommand("git", ["-C", input.repoRoot, "fetch", "--quiet", "origin"]);
        const shallow = await runCommand("git", ["-C", input.repoRoot, "rev-parse", "--is-shallow-repository"]);
        if (shallow.stdout.trim() === "true") {
            await runCommand("git", ["-C", input.repoRoot, "fetch", "--quiet", "--unshallow", "origin"]);
        }
    };
    const commitExists = async (sha) => {
        const r = await runCommand("git", ["-C", input.repoRoot, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
        return r.code === 0;
    };
    // Prefetch every /_meta probe in parallel with a short abort. It's a static
    // JSON file behind nginx — 3s is generous when the target is up, and a
    // black-holed host (sleeping test VM) would otherwise cost undici's 10s
    // connect timeout PER extension, sequentially: ~4 minutes for 23 exts.
    const META_TIMEOUT_MS = 3000;
    const metaCache = new Map();
    await Promise.all(names.flatMap((ext) => targetNames.map(async (targetName) => {
        const target = cfg.targets[targetName];
        const url = `${target.base_url.replace(/\/+$/, "")}/${ext}/_meta`;
        let sourceCommit = null;
        let error;
        try {
            const r = await fetch(url, { signal: AbortSignal.timeout(META_TIMEOUT_MS) });
            if (r.ok) {
                const body = (await r.json());
                if (typeof body?.sourceCommit === "string")
                    sourceCommit = body.sourceCommit;
            }
            else {
                error = `HTTP ${r.status}`;
            }
        }
        catch (e) {
            error =
                e.name === "TimeoutError"
                    ? `/_meta timeout after ${META_TIMEOUT_MS}ms (target down?)`
                    : e.message;
        }
        metaCache.set(`${targetName}::${ext}`, { sourceCommit, error });
    })));
    const rows = [];
    for (const ext of names) {
        const referenceTreeHash = await cachedTreeHash(input.reference, ext);
        const row = { extension: ext, referenceTreeHash, cells: {} };
        for (const targetName of targetNames) {
            const meta = metaCache.get(`${targetName}::${ext}`);
            const sourceCommit = meta.sourceCommit;
            let error = meta.error;
            let deployedTreeHash = null;
            let matchesReference = false;
            let branchHint = null;
            if (sourceCommit) {
                deployedTreeHash = await cachedTreeHash(sourceCommit, ext);
                if (deployedTreeHash === null && !(await commitExists(sourceCommit))) {
                    await recoverMissingObjects();
                    if (await commitExists(sourceCommit)) {
                        treeHashCache.delete(`${sourceCommit}::extensions/${ext}/src`);
                        deployedTreeHash = await cachedTreeHash(sourceCommit, ext);
                    }
                    else {
                        // Commit exists nowhere we can reach — likely squash-orphaned.
                        // "Can't verify" must not masquerade as "differs from ref".
                        error = `deployed commit ${sourceCommit} not in local git even after fetching origin (squash-orphaned?)`;
                    }
                }
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
export function renderDiff(report) {
    const nameCol = Math.max(9, ...report.rows.map((r) => r.extension.length));
    const cellCol = 18;
    const header = "extension".padEnd(nameCol) +
        "  " +
        report.targets.map((t) => t.padEnd(cellCol)).join("") +
        "state";
    const sep = "─".repeat(header.length);
    const lines = [header, sep];
    const shortSha = (s) => (s ? s.slice(0, 8) : "—       ");
    for (const row of report.rows) {
        const cells = report.targets.map((t) => {
            const cell = row.cells[t];
            if (!cell)
                return "?               ".padEnd(cellCol);
            if (cell.error)
                return `err: ${cell.error}`.padEnd(cellCol);
            if (!cell.sourceCommit)
                return "not deployed".padEnd(cellCol);
            // ✓ = source tree matches reference, ✗ = differs, ? = SHA not local (can't verify)
            const marker = cell.deployedTreeHash == null ? "?" : cell.matchesReference ? "✓" : "✗";
            return `${shortSha(cell.sourceCommit)} ${marker}`.padEnd(cellCol);
        });
        // Per-row state: aggregate across cells.
        const deployedCells = report.targets.map((t) => row.cells[t]).filter((c) => c?.sourceCommit);
        let state;
        if (deployedCells.length === 0) {
            state = "not deployed anywhere";
        }
        else if (deployedCells.every((c) => c.matchesReference)) {
            state = `matches ${report.reference}`;
        }
        else if (deployedCells.some((c) => c.deployedTreeHash == null)) {
            // Auto-fetch already ran — what's left is unreachable from any ref.
            const missing = deployedCells.filter((c) => c.deployedTreeHash == null).length;
            state = `${missing} deployed SHA(s) not in local git (squash-orphaned?) — can't verify`;
        }
        else {
            // Which targets differ from reference? Note the branch hint per target.
            const off = report.targets
                .map((t) => ({ t, c: row.cells[t] }))
                .filter(({ c }) => c?.sourceCommit && !c.matchesReference && c.deployedTreeHash != null);
            const detail = off.map(({ t, c }) => {
                const hint = c.branchHint ?? "orphaned (post-squash?)";
                return `${t}=${hint}`;
            });
            state = detail.join(" ");
        }
        lines.push(row.extension.padEnd(nameCol) + "  " + cells.join("") + state);
    }
    lines.push("");
    lines.push(`legend: ✓ = source tree matches ${report.reference}   ✗ = differs   ? = deployed SHA not in local git`);
    return lines.join("\n");
}
//# sourceMappingURL=extensions.js.map