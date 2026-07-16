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
async function gitBranchesContaining(repoRoot, sha) {
    const r = await runCommand("git", ["-C", repoRoot, "branch", "-r", "--contains", sha]);
    if (r.code !== 0)
        return [];
    return r.stdout
        .split("\n")
        .map((s) => s.replace(/^\*?\s+/, "").trim())
        .filter((s) => s.length > 0 && !s.startsWith("origin/HEAD"));
}
async function gitReferenceContains(repoRoot, reference, sha) {
    const r = await runCommand("git", ["-C", repoRoot, "merge-base", "--is-ancestor", sha, reference]);
    return r.code === 0;
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
    // Cache branch-contains + ancestor lookups per SHA (multiple targets may share a SHA).
    const containsCache = new Map();
    const ancestorCache = new Map();
    const rows = [];
    for (const ext of names) {
        const row = { extension: ext, cells: {} };
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
            let containingBranches = [];
            let onReference = false;
            if (sourceCommit) {
                if (containsCache.has(sourceCommit)) {
                    containingBranches = containsCache.get(sourceCommit);
                }
                else {
                    containingBranches = await gitBranchesContaining(input.repoRoot, sourceCommit);
                    containsCache.set(sourceCommit, containingBranches);
                }
                if (ancestorCache.has(sourceCommit)) {
                    onReference = ancestorCache.get(sourceCommit);
                }
                else {
                    onReference = await gitReferenceContains(input.repoRoot, input.reference, sourceCommit);
                    ancestorCache.set(sourceCommit, onReference);
                }
            }
            row.cells[targetName] = { target: targetName, sourceCommit, onReference, containingBranches, error };
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
            const marker = cell.onReference ? "✓" : "✗";
            return `${shortSha(cell.sourceCommit)} ${marker}`.padEnd(cellCol);
        });
        // Per-row state: aggregate across cells.
        const deployedCells = report.targets.map((t) => row.cells[t]).filter((c) => c?.sourceCommit);
        let state;
        if (deployedCells.length === 0) {
            state = "not deployed anywhere";
        }
        else if (deployedCells.every((c) => c.onReference)) {
            state = `on ${report.reference}`;
        }
        else {
            // Which targets are off-reference? Note the branches.
            const off = report.targets
                .map((t) => ({ t, c: row.cells[t] }))
                .filter(({ c }) => c?.sourceCommit && !c.onReference);
            const detail = off.map(({ t, c }) => {
                const brs = (c.containingBranches || []).filter((b) => b !== report.reference);
                const brief = brs.length === 1 ? brs[0] : brs.length ? `${brs.length} branches` : "unpushed?";
                return `${t}=${brief}`;
            });
            state = detail.join(" ");
        }
        lines.push(row.extension.padEnd(nameCol) + "  " + cells.join("") + state);
    }
    lines.push("");
    lines.push(`legend: ✓ = reachable from ${report.reference}   ✗ = not on ${report.reference}`);
    return lines.join("\n");
}
//# sourceMappingURL=extensions.js.map