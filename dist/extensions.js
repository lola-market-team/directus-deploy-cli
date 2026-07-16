import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
async function loadTargets(path) {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed?.targets || typeof parsed.targets !== "object") {
        throw new Error(`invalid targets file at ${path}: missing 'targets' object`);
    }
    return parsed;
}
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
    // Match scripts/deploy-extension.sh:
    //   git -C <root> log -1 --format=%h -- extensions/<name> :!extensions/<name>/dist :!extensions/<name>/src/build-info.ts
    const r = await assertCommand("git", [
        "-C",
        repoRoot,
        "log",
        "-1",
        "--format=%H",
        "--",
        `extensions/${extName}`,
        `:!extensions/${extName}/dist`,
        `:!extensions/${extName}/src/build-info.ts`,
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
async function verifyMeta(baseUrl, extName) {
    const url = `${baseUrl.replace(/\/+$/, "")}/${extName}/_meta`;
    try {
        // Poll for up to 20 s while the hot-reload picks up the swap.
        for (let i = 0; i < 10; i++) {
            const r = await fetch(url);
            if (r.ok) {
                const body = (await r.json());
                if (body?.sourceCommit)
                    return body.sourceCommit;
            }
            await new Promise((res) => setTimeout(res, 2000));
        }
    }
    catch {
        return null;
    }
    return null;
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
    await ssh(target, `set -e; ` +
        `if [ -d ${remoteFinal} ]; then mv ${remoteFinal} ${remoteFinal}_prev; fi; ` +
        `mv ${remoteStage} ${remoteFinal}; ` +
        `rm -rf ${remoteFinal}_prev`);
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
    const path = `extensions/${ext}`;
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
    const treeHashCache = new Map();
    const cachedTreeHash = async (ref, ext) => {
        const key = `${ref}::extensions/${ext}`;
        if (treeHashCache.has(key))
            return treeHashCache.get(key);
        const h = await gitTreeHash(input.repoRoot, ref, `extensions/${ext}`);
        treeHashCache.set(key, h);
        return h;
    };
    const rows = [];
    for (const ext of names) {
        const referenceTreeHash = await cachedTreeHash(input.reference, ext);
        const row = { extension: ext, referenceTreeHash, cells: {} };
        for (const targetName of targetNames) {
            const target = cfg.targets[targetName];
            const url = `${target.base_url.replace(/\/+$/, "")}/${ext}/_meta`;
            let sourceCommit = null;
            let error;
            try {
                const r = await fetch(url);
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
                error = e.message;
            }
            let deployedTreeHash = null;
            let matchesReference = false;
            let branchHint = null;
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
            // Fetch first, then compare — some SHAs aren't local yet.
            const missing = deployedCells.filter((c) => c.deployedTreeHash == null).length;
            state = `${missing} deployed SHA(s) not in local git — try 'git fetch --all'`;
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