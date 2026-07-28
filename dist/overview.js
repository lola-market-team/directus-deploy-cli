import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDirectusClient } from "./http.js";
import { run } from "./runner.js";
import { diffExtensions, loadTargets } from "./extensions.js";
// Per-check deadline. Applies to every leg of a target check — git, HTTP
// reconcilers, and drift probes alike. 0 disables. See #39: before this, one
// wedged leg blocked the whole command with no output and no upper bound.
//
// 5 minutes, not 1: the `config` leg legitimately takes ~70s per target
// (measured against staging + prod), while every other leg finishes inside 4s.
// A tighter ceiling would turn a normal slow day into a spurious TIMEOUT. The
// fine-grained bound lives one level down, in the HTTP client's per-request
// timeout and retry-elapsed ceiling — this is only the backstop.
export const OVERVIEW_TIMEOUT_MS = 300_000;
function isTimeout(e) {
    return Boolean(e) && e.timeout === true;
}
function timeoutErr(label, ms) {
    const e = new Error(`${label} timed out after ${ms}ms`);
    e.timeout = true;
    return e;
}
// Races `work` against a deadline. The underlying work is NOT cancelled (it is
// a reconciler mid-flight); the CLI process.exit()s and the MCP path lets it
// settle unobserved. What matters is that the caller stops waiting.
async function withDeadline(label, ms, work) {
    if (ms <= 0)
        return work;
    let timer;
    try {
        return await Promise.race([
            work,
            new Promise((_, rej) => {
                timer = setTimeout(() => rej(timeoutErr(label, ms)), ms);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function exec(cmd, args, cwd, timeoutMs = 0) {
    return new Promise((res, rej) => {
        // `detached` puts the child in its own process group so the deadline can
        // kill the whole tree. Killing the child pid alone is not enough: probes
        // run as `sh -c "<cmd>"`, and sh only exec-replaces itself for a SINGLE
        // command — `a | b` or `cd x && a` leaves the real worker as a grandchild
        // that survives the kill and keeps holding its connection to the target.
        const child = spawn(cmd, args, { cwd, detached: timeoutMs > 0 });
        let stdout = "";
        let stderr = "";
        let timer;
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                try {
                    // Negative pid = the whole process group.
                    if (child.pid)
                        process.kill(-child.pid, "SIGKILL");
                }
                catch {
                    // Group already gone (ESRCH) — fall back to the direct child.
                    try {
                        child.kill("SIGKILL");
                    }
                    catch { /* already dead */ }
                }
                rej(timeoutErr(`${cmd} ${args[0] ?? ""}`.trim(), timeoutMs));
            }, timeoutMs);
            timer.unref?.();
        }
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));
        child.on("error", (e) => { if (timer)
            clearTimeout(timer); rej(e); });
        child.on("close", (code) => {
            if (timer)
                clearTimeout(timer);
            res({ code: code ?? -1, stdout, stderr });
        });
    });
}
// git is bounded too: `fetch`/`rev-parse` against an unreachable remote hangs
// on TCP timeout, which is a hang the caller cannot distinguish from work.
async function git(repoRoot, args, timeoutMs = OVERVIEW_TIMEOUT_MS) {
    const r = await exec("git", ["-C", repoRoot, ...args], undefined, timeoutMs);
    if (r.code !== 0) {
        throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    }
    return r.stdout;
}
const COMMIT_LIST_CAP = 30;
function parseCommitLog(raw) {
    return raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
        const [sha = "", ...rest] = l.split("\t");
        return { sha, subject: rest.join("\t") };
    });
}
// Classify `git diff --name-status <to> <from>` lines into the overview's
// four dimensions. Pure — exported for tests.
export function classifyPromotionPaths(entries) {
    const migrations = { added: [], modified: [], removed: [] };
    const extSet = new Set();
    const schema = [];
    const seeds = [];
    for (const { status, path } of entries) {
        // register manifests are config, not runnable SQL — schema dimension.
        if (/^migrations\/register\//.test(path)) {
            schema.push(path);
            continue;
        }
        const extMigration = path.match(/^extensions\/([^/]+)\/migrations\/.+\.sql$/);
        if (/^migrations\/[^/]+\.sql$/.test(path) || extMigration) {
            const label = extMigration ? `ext/${extMigration[1]}/${path.split("/").pop()}` : path.replace(/^migrations\//, "");
            if (status === "A")
                migrations.added.push(label);
            else if (status === "D")
                migrations.removed.push(label);
            else
                migrations.modified.push(label);
            continue;
        }
        if (/^directus_config\/(snapshot|collections)\//.test(path)) {
            schema.push(path);
            continue;
        }
        if (/^directus_config\/seed\//.test(path)) {
            seeds.push(path);
            continue;
        }
        const extSrc = path.match(/^extensions\/([^/]+)\/src\//);
        if (extSrc)
            extSet.add(extSrc[1]);
    }
    return {
        migrations,
        extensions: [...extSet].sort(),
        schema: schema.sort(),
        seeds: seeds.sort(),
    };
}
export async function computePromotionQueue(repoRoot, from, to, timeoutMs = OVERVIEW_TIMEOUT_MS) {
    // Bound every git invocation to the caller's deadline, so `--timeout 0`
    // genuinely disables rather than silently leaving git on its own default.
    const g = (args) => git(repoRoot, args, timeoutMs);
    const ahead = Number((await g(["rev-list", "--count", `${to}..${from}`])).trim());
    // Behind answers "does `to` hold CONTENT that `from` lacks" — the thing the
    // next release would clobber. Raw SHA counting inflates it with (a) the
    // merge commit every release PR mints on `to`, one per release forever, and
    // (b) patch-id twins: a squash-hotfix re-applied to `from` under a new SHA.
    // --cherry-pick cancels patch-equivalent pairs across the symmetric range;
    // --no-merges drops merge commits (they have no patch-id and would always
    // count). What's left is genuinely missing from `from` — a back-port that
    // needed even one line of conflict resolution still counts, correctly.
    const behind = Number((await g([
        "rev-list",
        "--count",
        "--right-only",
        "--cherry-pick",
        "--no-merges",
        `${from}...${to}`,
    ])).trim());
    const raw = await g([
        "diff",
        "--name-status",
        "--no-renames",
        to,
        from,
        "--",
        "directus_config",
        "migrations",
        "extensions",
    ]);
    const entries = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
        const [status = "", ...rest] = l.split("\t");
        return { status: status.charAt(0), path: rest.join("\t") };
    });
    const classified = classifyPromotionPaths(entries);
    const commits = parseCommitLog(await g(["log", "--format=%h%x09%s", "-n", String(COMMIT_LIST_CAP), `${to}..${from}`]));
    const extensionDetails = [];
    for (const name of classified.extensions) {
        // Same pathspec as resolveArtifactSourceCommit — the bucket filename /
        // /_meta.sourceCommit convention.
        const pathspec = [
            "--",
            `extensions/${name}`,
            `:!extensions/${name}/dist`,
            `:!extensions/${name}/src/build-info.ts`,
        ];
        let expected = null;
        try {
            expected = (await g(["log", "-1", "--format=%h", from, ...pathspec])).trim() || null;
        }
        catch {
            // ref vanished mid-run or pathspec quirk — detail row still renders
        }
        let extCommits = [];
        try {
            extCommits = parseCommitLog(await g(["log", "--format=%h%x09%s", "-n", String(COMMIT_LIST_CAP), `${to}..${from}`, ...pathspec]));
        }
        catch {
            // same — leave the commit list empty rather than dropping the row
        }
        extensionDetails.push({ name, expected, running: null, commits: extCommits });
    }
    return {
        from,
        to,
        commitsAhead: ahead,
        commitsBehind: behind,
        commits,
        commitsTruncated: ahead > COMMIT_LIST_CAP,
        ...classified,
        extensionDetails,
    };
}
// -------------------- ref materialization --------------------
// Extract the deployable dirs at a ref into a temp dir so the file-reading
// reconcilers see the branch's state instead of the working tree. `extensions`
// is included because the migrations reconciler scans extensions/*/migrations.
async function materializeRef(repoRoot, ref, timeoutMs = OVERVIEW_TIMEOUT_MS) {
    const dir = await mkdtemp(join(tmpdir(), "dd-overview-"));
    const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
    // A pipeline, so sh cannot exec-replace itself — without a deadline here the
    // git and tar processes outlive an abandoned check entirely.
    const cmd = `git -C ${quote(repoRoot)} archive ${quote(ref)} directus_config migrations extensions | tar -xf - -C ${quote(dir)}`;
    const r = await exec("sh", ["-c", cmd], undefined, timeoutMs);
    if (r.code !== 0) {
        await rm(dir, { recursive: true, force: true });
        throw new Error(`could not materialize ${ref}: ${r.stderr.trim() || r.stdout.trim()} (is the ref fetched?)`);
    }
    return dir;
}
const CONFIG_ENTITIES = [
    "collections",
    "fields",
    "relations",
    "roles",
    "policies",
    "permissions",
    "flows",
    "operations",
];
const LAYOUT = {
    snapshotDir: "directus_config/snapshot",
    configDir: "directus_config/collections",
    registerDir: "migrations/register",
    seedDir: "directus_config/seed",
    migrationsDir: "migrations",
    extensionsDir: "extensions",
};
async function checkTarget(input) {
    // Every leg reports start/finish and is bounded by the same deadline. A leg
    // that trips it becomes a TIMEOUT cell (an error, so exit 2) instead of
    // stalling the run.
    const track = async (stage, run, describe) => {
        input.onProgress?.({ target: input.name, stage, status: "start" });
        const t0 = Date.now();
        try {
            const v = await withDeadline(`${input.name} ${stage}`, input.timeoutMs, run());
            const detail = describe(v);
            const err = v?.error;
            input.onProgress?.({
                target: input.name, stage,
                status: err ? "error" : "ok",
                ms: Date.now() - t0, detail: err ?? detail,
            });
            return v;
        }
        catch (e) {
            const message = e.message;
            input.onProgress?.({
                target: input.name, stage,
                status: isTimeout(e) ? "timeout" : "error",
                ms: Date.now() - t0, detail: message,
            });
            return { error: isTimeout(e) ? `TIMEOUT ${message}` : message };
        }
    };
    const out = {
        target: input.name,
        ref: input.ref,
        migrations: { error: "not run" },
        extensions: { error: "not run" },
        config: { error: "not run" },
        seeds: { error: "not run" },
        probes: {},
    };
    // Extensions need no token — always attempted. Compares deployed source
    // tree hash against the target's ref (worktree targets compare vs HEAD).
    const extPromise = track("extensions", async () => {
        try {
            const report = await diffExtensions({
                targetsFile: input.targetsFile,
                targets: [input.name],
                repoRoot: input.repoRoot,
                reference: input.ref ?? "HEAD",
            });
            const summary = { match: 0, drift: 0, missing: 0, driftList: [], missingList: [], sourceCommits: {} };
            for (const row of report.rows) {
                const cell = row.cells[input.name];
                if (!cell)
                    continue;
                summary.sourceCommits[row.extension] = cell.sourceCommit;
                if (cell.error) {
                    summary.missing++;
                    summary.missingList.push(row.extension);
                }
                else if (cell.matchesReference) {
                    summary.match++;
                }
                else {
                    summary.drift++;
                    summary.driftList.push({ name: row.extension, hint: cell.branchHint });
                }
            }
            return summary;
        }
        catch (e) {
            if (isTimeout(e))
                throw e; // render TIMEOUT, not a generic error
            return { error: e.message };
        }
    }, (v) => isErr(v) ? undefined : `${v.match} match, ${v.drift} drift, ${v.missing} missing`);
    const token = process.env[input.tokenEnv];
    if (!token) {
        const error = `${input.tokenEnv} not set`;
        out.migrations = { error };
        out.config = { error };
        out.seeds = { error };
        out.extensions = await extPromise;
        return out;
    }
    const client = createDirectusClient({ baseUrl: input.baseUrl, token });
    const p = (rel) => join(input.layoutRoot, rel);
    const migPromise = track("migrations", async () => {
        try {
            const { reconcileMigrations } = await import("./reconcilers/migrations.js");
            const results = await reconcileMigrations({
                migrationsDir: p(LAYOUT.migrationsDir),
                extensionsDir: p(LAYOUT.extensionsDir),
                includeExtensions: true,
                client,
                opts: { dryRun: true },
            });
            if (results.length === 1 && results[0]?.label === "migrations") {
                return { error: results[0].reason ?? "target unreachable" };
            }
            const s = { applied: 0, pending: 0, mutated: 0, pendingList: [], mutatedList: [] };
            for (const r of results) {
                const f = r.label.replace(/^migrations\//, "");
                if (r.action === "unchanged")
                    s.applied++;
                else if (r.action === "created") {
                    s.pending++;
                    s.pendingList.push(f);
                }
                else if (r.action === "failed") {
                    s.mutated++;
                    s.mutatedList.push(f);
                }
            }
            return s;
        }
        catch (e) {
            if (isTimeout(e))
                throw e; // render TIMEOUT, not a generic error
            return { error: e.message };
        }
    }, (v) => isErr(v) ? undefined : `${v.applied} applied, ${v.pending} pending, ${v.mutated} mutated`);
    const cfgPromise = track("config", async () => {
        try {
            const report = await run({
                target: input.name,
                paths: {
                    snapshotDir: p(LAYOUT.snapshotDir),
                    configDir: p(LAYOUT.configDir),
                    registerDir: p(LAYOUT.registerDir),
                },
                migrationsDir: p(LAYOUT.migrationsDir),
                extensionsDir: p(LAYOUT.extensionsDir),
                includeExtensions: true,
                seedDir: p(LAYOUT.seedDir),
                client,
                opts: { dryRun: true },
                entities: new Set([...CONFIG_ENTITIES, "seeds"]),
            });
            const config = { changes: 0, changeList: [], unmanaged: 0, unmanagedList: [] };
            const seeds = { changes: 0, changeList: [], unmanaged: 0, unmanagedList: [] };
            for (const r of report.results) {
                const bucket = r.kind === "seeds" ? seeds : config;
                if (r.unmanaged) {
                    bucket.unmanaged = (bucket.unmanaged ?? 0) + r.unmanaged;
                    bucket.unmanagedList.push(`? ${r.label} — ${r.reason ?? `${r.unmanaged} row(s) not in seed`}`);
                }
                if (r.action !== "created" && r.action !== "updated" && r.action !== "extra")
                    continue;
                bucket.changes++;
                bucket.changeList.push(`${r.action === "created" ? "+" : r.action === "extra" ? "!" : "~"} ${r.label}`);
            }
            return { config, seeds };
        }
        catch (e) {
            if (isTimeout(e))
                throw e; // render TIMEOUT, not a generic error
            const error = e.message;
            return { config: { error }, seeds: { error } };
        }
    }, (v) => "config" in v && !isErr(v.config) && !isErr(v.seeds)
        ? `${v.config.changes} config, ${v.seeds.changes} seed changes` +
            (v.seeds.unmanaged ? `, ${v.seeds.unmanaged} unmanaged` : "")
        : undefined);
    // Custom drift probes (#38): repo-declared commands, run from the WORKING
    // TREE (repoRoot) — probes compare the env against the repo's current
    // committed state, and the probe script itself may not exist at older refs.
    // A probe exiting non-zero is fine as long as it printed the JSON contract
    // (drift is exit 1 by convention).
    const probesPromise = (async () => {
        const res = {};
        await Promise.all(input.probes.map(async (p) => {
            const cmd = p.cmd
                .replaceAll("{url}", input.baseUrl)
                .replaceAll("{token_env}", input.tokenEnv)
                .replaceAll("{target}", input.name);
            // Tracked individually — probes are repo-supplied commands and are the
            // most likely thing to be slow, so "which probe" is the useful signal.
            const tracked = await track(`probe:${p.name}`, async () => {
                try {
                    const r = await exec("sh", ["-c", cmd], input.repoRoot, input.timeoutMs);
                    const lastLine = r.stdout.trim().split("\n").pop() ?? "";
                    let parsed;
                    try {
                        parsed = JSON.parse(lastLine);
                    }
                    catch {
                        throw new Error(r.code === 0
                            ? "probe printed no JSON"
                            : `exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
                    }
                    if (parsed.error)
                        throw new Error(parsed.error);
                    return { clean: Boolean(parsed.clean), summary: parsed.summary };
                }
                catch (e) {
                    // A deadline is not a probe failure — let it reach track() so the
                    // cell renders TIMEOUT rather than an ordinary probe error.
                    if (isTimeout(e))
                        throw e;
                    return { error: e.message };
                }
            }, (v) => (isErr(v) ? undefined : (v.summary ?? (v.clean ? "clean" : "drift"))));
            res[p.name] = tracked;
        }));
        return res;
    })();
    const [ext, mig, cfg, probes] = await Promise.all([extPromise, migPromise, cfgPromise, probesPromise]);
    out.extensions = ext;
    out.migrations = mig;
    // config and seeds share one reconcile pass, so a timeout on that pass fails
    // both cells rather than leaving them at the "not run" placeholder.
    out.config = "config" in cfg ? cfg.config : cfg;
    out.seeds = "config" in cfg ? cfg.seeds : cfg;
    out.probes = probes;
    return out;
}
// Infer the promotion pair from the targets' refs: exactly two distinct refs,
// where a build_forbidden (prod-like) target pins the `to` side.
export function inferPromotionPair(targets) {
    const refs = [...new Set(targets.map((t) => t.ref).filter((r) => r !== null))];
    if (refs.length !== 2) {
        return { skipped: `need exactly 2 distinct refs across targets to infer the pair (found ${refs.length}) — pass --from/--to` };
    }
    const prodRefs = [...new Set(targets.filter((t) => t.buildForbidden && t.ref).map((t) => t.ref))];
    if (prodRefs.length !== 1) {
        return { skipped: "could not tell which ref is the promotion destination — pass --from/--to" };
    }
    const to = prodRefs[0];
    const from = refs.find((r) => r !== to);
    return { from, to };
}
// The promotion queue is repo state, not target state — probing a single-ref
// subset (`--targets staging,prod` on the same ref, or one target) must not
// lose the column. Widen to the full targets file, then to the conventional
// branch pair; a nonexistent fallback ref surfaces as promotionSkipped via
// the git error downstream.
export function resolvePromotionPair(probed, all) {
    const fromProbed = inferPromotionPair(probed);
    if (!("skipped" in fromProbed))
        return fromProbed;
    const fromAll = inferPromotionPair(all);
    if (!("skipped" in fromAll))
        return fromAll;
    return { from: "origin/develop", to: "origin/master", fallback: fromAll.skipped };
}
export async function runOverview(input) {
    const repoRoot = resolve(input.repoRoot);
    const timeoutMs = input.timeoutMs ?? OVERVIEW_TIMEOUT_MS;
    const cfg = await loadTargets(input.targetsFile);
    const names = input.targets?.length ? input.targets : Object.keys(cfg.targets);
    const missing = names.filter((n) => !cfg.targets[n]);
    if (missing.length)
        throw new Error(`unknown target(s): ${missing.join(", ")}`);
    // Materialize each distinct ref once, shared across targets.
    const matCache = new Map();
    const materialized = (ref) => {
        let p = matCache.get(ref);
        if (!p) {
            p = materializeRef(repoRoot, ref, timeoutMs);
            matCache.set(ref, p);
        }
        return p;
    };
    const targetChecks = names.map(async (name) => {
        const t = cfg.targets[name];
        const ref = t.ref ?? null;
        let layoutRoot = repoRoot;
        if (ref) {
            try {
                input.onProgress?.({ target: name, stage: "materialize", status: "start", detail: ref });
                const t0 = Date.now();
                layoutRoot = await withDeadline(`${name} materialize`, timeoutMs, materialized(ref));
                input.onProgress?.({ target: name, stage: "materialize", status: "ok", ms: Date.now() - t0, detail: ref });
            }
            catch (e) {
                input.onProgress?.({
                    target: name, stage: "materialize",
                    status: isTimeout(e) ? "timeout" : "error",
                    detail: e.message,
                });
                const error = e.message;
                return {
                    target: name,
                    ref,
                    migrations: { error },
                    extensions: { error },
                    config: { error },
                    seeds: { error },
                    probes: {},
                };
            }
        }
        return checkTarget({
            name,
            baseUrl: t.base_url,
            tokenEnv: t.token_env ?? `DIRECTUS_${name.toUpperCase()}_TOKEN`,
            ref,
            layoutRoot,
            repoRoot,
            targetsFile: input.targetsFile,
            probes: cfg.drift_probes ?? [],
            onProgress: input.onProgress,
            timeoutMs,
        });
    });
    let promotion = null;
    let promotionSkipped;
    let pair;
    if (input.from && input.to) {
        pair = { from: input.from, to: input.to };
    }
    else if (input.from || input.to) {
        pair = { skipped: "--from and --to must be passed together" };
    }
    else {
        const shape = (n) => ({
            ref: cfg.targets[n].ref ?? null,
            buildForbidden: Boolean(cfg.targets[n].build_forbidden),
        });
        pair = resolvePromotionPair(names.map(shape), Object.keys(cfg.targets).map(shape));
    }
    const promotionPromise = (async () => {
        if ("skipped" in pair) {
            promotionSkipped = pair.skipped;
            return;
        }
        input.onProgress?.({ target: "repo", stage: "promotion", status: "start", detail: `${pair.from} → ${pair.to}` });
        const t0 = Date.now();
        try {
            promotion = await withDeadline("promotion queue", timeoutMs, computePromotionQueue(repoRoot, pair.from, pair.to, timeoutMs));
            input.onProgress?.({ target: "repo", stage: "promotion", status: "ok", ms: Date.now() - t0 });
        }
        catch (e) {
            input.onProgress?.({
                target: "repo", stage: "promotion",
                status: isTimeout(e) ? "timeout" : "error",
                ms: Date.now() - t0, detail: e.message,
            });
            promotionSkipped = pair.fallback
                ? `${pair.fallback}; fallback ${pair.from} → ${pair.to} failed: ${e.message}`
                : e.message;
        }
    })();
    const targets = await Promise.all(targetChecks);
    await promotionPromise;
    // Release preview join: what does the destination currently run? A probed
    // target deployed from the `to` ref already fetched /_meta sourceCommit
    // for every extension — reuse it, no extra network.
    if (promotion !== null) {
        const p = promotion;
        const dest = targets.find((t) => t.ref === p.to && !isErr(t.extensions));
        if (dest) {
            const running = dest.extensions.sourceCommits;
            for (const d of p.extensionDetails) {
                const commit = running[d.name];
                if (commit)
                    d.running = { target: dest.target, commit };
            }
        }
    }
    // Best-effort temp cleanup — a leaked dir in tmpdir is harmless.
    for (const p of matCache.values()) {
        p.then((dir) => rm(dir, { recursive: true, force: true })).catch(() => { });
    }
    return { targets, promotion, promotionSkipped };
}
// -------------------- rendering --------------------
function isErr(d) {
    return typeof d.error === "string";
}
function cellMigrations(d) {
    if (isErr(d))
        return "⚠ unreachable";
    if (d.pending === 0 && d.mutated === 0)
        return `✓ ${d.applied} applied`;
    const parts = [`${d.pending} pending`];
    if (d.mutated > 0)
        parts.push(`${d.mutated} mutated`);
    return `✗ ${parts.join(", ")}`;
}
function cellExtensions(d) {
    if (isErr(d))
        return "⚠ unreachable";
    const total = d.match + d.drift + d.missing;
    if (d.drift === 0)
        return `✓ ${d.match}/${total} match`;
    return `✗ ${d.drift} behind`;
}
function cellChanges(d) {
    if (isErr(d))
        return "⚠ unreachable";
    if (d.changes > 0)
        return `✗ ${d.changes} change${d.changes === 1 ? "" : "s"}`;
    // No pending work, but the target still holds rows the seed does not. Say so
    // rather than claiming parity: "✓ in sync" over a real divergence is how a
    // collection stays diverged for months without anyone noticing.
    if (d.unmanaged)
        return `? ${d.unmanaged} unmanaged`;
    return "✓ in sync";
}
export function renderOverview(report) {
    const dims = ["migrations", "extensions", "config", "seeds"];
    const colWidth = 20;
    const labelWidth = 14;
    const headers = [];
    const subHeaders = [];
    for (const t of report.targets) {
        headers.push(t.target);
        subHeaders.push(t.ref ? `vs ${t.ref}` : "vs worktree");
    }
    const promo = report.promotion;
    if (promo) {
        headers.push(`${short(promo.from)} → ${short(promo.to)}`);
        subHeaders.push("promotion queue");
    }
    const lines = [];
    lines.push("".padEnd(labelWidth) + headers.map((h) => h.padEnd(colWidth)).join("").trimEnd());
    lines.push("".padEnd(labelWidth) + subHeaders.map((h) => h.padEnd(colWidth)).join("").trimEnd());
    lines.push("");
    for (const dim of dims) {
        const cells = [];
        for (const t of report.targets) {
            switch (dim) {
                case "migrations":
                    cells.push(cellMigrations(t.migrations));
                    break;
                case "extensions":
                    cells.push(cellExtensions(t.extensions));
                    break;
                case "config":
                    cells.push(cellChanges(t.config));
                    break;
                case "seeds":
                    cells.push(cellChanges(t.seeds));
                    break;
            }
        }
        if (promo)
            cells.push(promotionCell(dim, promo));
        lines.push(`  ${dim.padEnd(labelWidth - 2)}` + cells.map((c) => c.padEnd(colWidth)).join("").trimEnd());
    }
    // Custom drift-probe rows (#38) — union of probe names across targets.
    const probeNames = [...new Set(report.targets.flatMap((t) => Object.keys(t.probes ?? {})))];
    for (const name of probeNames) {
        const cells = [];
        for (const t of report.targets) {
            const d = (t.probes ?? {})[name];
            cells.push(d === undefined ? "—" : cellProbe(d));
        }
        if (promo)
            cells.push("—");
        lines.push(`  ${name.padEnd(labelWidth - 2)}` + cells.map((c) => c.padEnd(colWidth)).join("").trimEnd());
    }
    // Detail block: every red/⚠ cell explains itself.
    const details = [];
    for (const t of report.targets) {
        if (isErr(t.migrations))
            details.push(`⚠ ${t.target} migrations: ${t.migrations.error}`);
        else {
            if (t.migrations.pendingList.length)
                details.push(`✗ ${t.target} migrations pending: ${t.migrations.pendingList.join(", ")}`);
            if (t.migrations.mutatedList.length)
                details.push(`✗ ${t.target} migrations MUTATED: ${t.migrations.mutatedList.join(", ")}`);
        }
        if (isErr(t.extensions))
            details.push(`⚠ ${t.target} extensions: ${t.extensions.error}`);
        else {
            for (const d of t.extensions.driftList)
                details.push(`✗ ${t.target} extension ${d.name} differs from ${t.ref ?? "HEAD"}${d.hint ? ` — running ${d.hint}` : ""}`);
            if (t.extensions.missingList.length)
                details.push(`? ${t.target} extensions uncheckable (no _meta, or deployed commit not in local git): ${t.extensions.missingList.join(", ")}`);
        }
        if (isErr(t.config))
            details.push(`⚠ ${t.target} config: ${t.config.error}`);
        else
            for (const c of truncate(t.config.changeList))
                details.push(`✗ ${t.target} config ${c}`);
        if (isErr(t.seeds))
            details.push(`⚠ ${t.target} seeds: ${t.seeds.error}`);
        else {
            for (const c of truncate(t.seeds.changeList))
                details.push(`✗ ${t.target} seeds ${c}`);
            for (const c of truncate(t.seeds.unmanagedList ?? []))
                details.push(`${t.target} seeds ${c}`);
        }
        for (const [name, d] of Object.entries(t.probes ?? {})) {
            if (isErr(d))
                details.push(`⚠ ${t.target} ${name}: ${d.error}`);
            else if (!d.clean)
                details.push(`✗ ${t.target} ${name}: ${d.summary ?? "drift"}`);
        }
    }
    if (details.length) {
        lines.push("");
        lines.push(...details.map((d) => `  ${d}`));
    }
    lines.push("");
    if (promo) {
        lines.push(`  ${short(promo.from)} is ${promo.commitsAhead} commit(s) ahead of ${short(promo.to)}` +
            (promo.commitsBehind > 0
                ? ` — and ${short(promo.to)} has ${promo.commitsBehind} commit(s) not on ${short(promo.from)} (hotfix?)`
                : ""));
        const promoDetails = [];
        for (const c of truncate(promo.commits.map((x) => `${x.sha}  ${x.subject}`), 10)) {
            promoDetails.push(`    ${c}`);
        }
        if (promo.commitsTruncated && promo.commitsAhead > promo.commits.length) {
            promoDetails.push(`    … commit list capped at ${promo.commits.length} (see --json)`);
        }
        for (const m of promo.migrations.added)
            promoDetails.push(`  queued migration: ${m}`);
        for (const m of promo.migrations.modified)
            promoDetails.push(`  ⚠ migration MODIFIED between refs: ${m}`);
        for (const m of promo.migrations.removed)
            promoDetails.push(`  ⚠ migration removed on ${short(promo.from)}: ${m}`);
        for (const d of promo.extensionDetails) {
            const would = d.expected ? `would get ${d.expected}` : "queued";
            const head = d.running
                ? `${d.running.target} runs ${d.running.commit} → ${would}`
                : d.expected
                    ? `would deploy ${d.expected}`
                    : "queued";
            promoDetails.push(`  queued extension ${d.name} — ${head}`);
            for (const c of truncate(d.commits.map((x) => `${x.sha}  ${x.subject}`), 8)) {
                promoDetails.push(`    ${c}`);
            }
        }
        // Extensions the diff flagged but detail resolution missed entirely.
        const detailed = new Set(promo.extensionDetails.map((d) => d.name));
        const undetailed = promo.extensions.filter((n) => !detailed.has(n));
        if (undetailed.length)
            promoDetails.push(`  queued extensions: ${undetailed.join(", ")}`);
        if (promoDetails.length)
            lines.push(...promoDetails.map((d) => `  ${d}`));
    }
    else if (report.promotionSkipped) {
        lines.push(`  (promotion column skipped: ${report.promotionSkipped})`);
    }
    const anyDrift = hasDrift(report);
    const anyErr = hasErrors(report);
    // Unmanaged rows are deliberately NOT drift: no command acts on them, so
    // they must not flip the exit code. They do have to change the closing
    // sentence though -- "All environments in sync" over a known divergence is
    // the exact wording that let 23 stale rows sit on prod unnoticed.
    const unmanaged = report.targets.reduce((n, t) => n + (isErr(t.seeds) ? 0 : (t.seeds.unmanaged ?? 0)), 0);
    lines.push("");
    lines.push(anyDrift
        ? "  Drift detected."
        : anyErr
            ? "  No drift found, but some checks could not run."
            : unmanaged > 0
                ? `  No actionable drift. ${unmanaged} unmanaged row(s) diverge — enable meta.delete to prune, or pull them into the seed.`
                : "  All environments in sync.");
    return lines.join("\n");
}
function cellProbe(d) {
    if (isErr(d))
        return "⚠ error";
    if (d.clean)
        return "✓ in sync";
    // Cell must fit the matrix column — the detail block carries the full text.
    const s = d.summary ?? "drift";
    return `✗ ${s.length > 15 ? s.slice(0, 14) + "…" : s}`;
}
function short(ref) {
    return ref.replace(/^origin\//, "");
}
// Keep the detail block readable when a whole collection changes at once —
// the full list is always available via --json.
function truncate(list, max = 6) {
    if (list.length <= max)
        return list;
    return [...list.slice(0, max - 1), `… and ${list.length - (max - 1)} more (see --json)`];
}
function promotionCell(dim, p) {
    switch (dim) {
        case "migrations": {
            const n = p.migrations.added.length;
            const warn = p.migrations.modified.length + p.migrations.removed.length;
            if (n === 0 && warn === 0)
                return "none";
            return `${n} new${warn ? ` (⚠ ${warn})` : ""}`;
        }
        case "extensions":
            return p.extensions.length === 0 ? "none" : `${p.extensions.length} changed`;
        case "config":
            return p.schema.length === 0 ? "none" : `${p.schema.length} file(s)`;
        case "seeds":
            return p.seeds.length === 0 ? "none" : `${p.seeds.length} file(s)`;
    }
}
export function hasDrift(report) {
    for (const t of report.targets) {
        if (!isErr(t.migrations) && (t.migrations.pending > 0 || t.migrations.mutated > 0))
            return true;
        if (!isErr(t.extensions) && t.extensions.drift > 0)
            return true;
        if (!isErr(t.config) && t.config.changes > 0)
            return true;
        if (!isErr(t.seeds) && t.seeds.changes > 0)
            return true;
        for (const d of Object.values(t.probes ?? {}))
            if (!isErr(d) && !d.clean)
                return true;
    }
    return false;
}
export function hasErrors(report) {
    return report.targets.some((t) => isErr(t.migrations) ||
        isErr(t.extensions) ||
        isErr(t.config) ||
        isErr(t.seeds) ||
        Object.values(t.probes ?? {}).some(isErr));
}
//# sourceMappingURL=overview.js.map