import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDirectusClient } from "./http.js";
import { run } from "./runner.js";
import { diffExtensions, loadTargets } from "./extensions.js";
import type { EntityKind } from "./types.js";

// Overview: one matrix over every target — each env compared against the git
// ref it is deployed from (targets file `ref` field), plus a promotion-queue
// column showing what sits on `from` (develop) that hasn't reached `to`
// (master) yet.
//
// Env columns compare the target against the ARTIFACTS AT ITS REF, not the
// working tree: the ref's directus_config/ + migrations/ are materialized
// into a temp dir via `git archive` and the normal dry-run reconcilers point
// there. Extensions are compared by source tree hash (diffExtensions), which
// needs no materialization. A target with no `ref` falls back to the working
// tree — same behavior as `diff`.
//
// The promotion column is pure git (no network): `git diff --name-status
// to from` over the deployable paths, classified into the same four
// dimensions. It is informational and never affects the exit code — pending
// promotion is a normal state, not drift.

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: string[], cwd?: string): Promise<ExecResult> {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => rej(e));
    child.on("close", (code) => res({ code: code ?? -1, stdout, stderr }));
  });
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const r = await exec("git", ["-C", repoRoot, ...args]);
  if (r.code !== 0) {
    throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout;
}

// -------------------- promotion queue --------------------

export interface PromotionQueue {
  from: string;
  to: string;
  commitsAhead: number;   // commits on `from` not on `to`
  commitsBehind: number;  // commits on `to` not on `from` (hotfix smell)
  migrations: { added: string[]; modified: string[]; removed: string[] };
  extensions: string[];   // extension names whose src/ differs
  schema: string[];       // snapshot/collections/register files that differ
  seeds: string[];        // seed files that differ
}

// Classify `git diff --name-status <to> <from>` lines into the overview's
// four dimensions. Pure — exported for tests.
export function classifyPromotionPaths(
  entries: Array<{ status: string; path: string }>,
): Pick<PromotionQueue, "migrations" | "extensions" | "schema" | "seeds"> {
  const migrations = { added: [] as string[], modified: [] as string[], removed: [] as string[] };
  const extSet = new Set<string>();
  const schema: string[] = [];
  const seeds: string[] = [];

  for (const { status, path } of entries) {
    // register manifests are config, not runnable SQL — schema dimension.
    if (/^migrations\/register\//.test(path)) {
      schema.push(path);
      continue;
    }
    const extMigration = path.match(/^extensions\/([^/]+)\/migrations\/.+\.sql$/);
    if (/^migrations\/[^/]+\.sql$/.test(path) || extMigration) {
      const label = extMigration ? `ext/${extMigration[1]}/${path.split("/").pop()}` : path.replace(/^migrations\//, "");
      if (status === "A") migrations.added.push(label);
      else if (status === "D") migrations.removed.push(label);
      else migrations.modified.push(label);
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
    if (extSrc) extSet.add(extSrc[1]!);
  }
  return {
    migrations,
    extensions: [...extSet].sort(),
    schema: schema.sort(),
    seeds: seeds.sort(),
  };
}

export async function computePromotionQueue(
  repoRoot: string,
  from: string,
  to: string,
): Promise<PromotionQueue> {
  const ahead = Number((await git(repoRoot, ["rev-list", "--count", `${to}..${from}`])).trim());
  const behind = Number((await git(repoRoot, ["rev-list", "--count", `${from}..${to}`])).trim());
  const raw = await git(repoRoot, [
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
  return { from, to, commitsAhead: ahead, commitsBehind: behind, ...classifyPromotionPaths(entries) };
}

// -------------------- ref materialization --------------------

// Extract the deployable dirs at a ref into a temp dir so the file-reading
// reconcilers see the branch's state instead of the working tree. `extensions`
// is included because the migrations reconciler scans extensions/*/migrations.
async function materializeRef(repoRoot: string, ref: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dd-overview-"));
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const cmd = `git -C ${quote(repoRoot)} archive ${quote(ref)} directus_config migrations extensions | tar -xf - -C ${quote(dir)}`;
  const r = await exec("sh", ["-c", cmd]);
  if (r.code !== 0) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`could not materialize ${ref}: ${r.stderr.trim() || r.stdout.trim()} (is the ref fetched?)`);
  }
  return dir;
}

// -------------------- per-target checks --------------------

export interface MigrationsSummary {
  applied: number;
  pending: number;
  mutated: number;
  pendingList: string[];
  mutatedList: string[];
}

export interface ExtensionsSummary {
  match: number;
  drift: number;
  missing: number;
  driftList: Array<{ name: string; hint: string | null }>;
  missingList: string[];
}

export interface ChangeSummary {
  changes: number;
  changeList: string[];
}

export type Dimension<T> = T | { error: string };

export interface TargetOverview {
  target: string;
  ref: string | null; // null = compared against working tree
  migrations: Dimension<MigrationsSummary>;
  extensions: Dimension<ExtensionsSummary>;
  config: Dimension<ChangeSummary>;
  seeds: Dimension<ChangeSummary>;
}

export interface OverviewReport {
  targets: TargetOverview[];
  promotion: PromotionQueue | null;
  promotionSkipped?: string; // why the promotion column is absent
}

const CONFIG_ENTITIES: EntityKind[] = [
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

async function checkTarget(input: {
  name: string;
  baseUrl: string;
  tokenEnv: string;
  ref: string | null;
  layoutRoot: string; // materialized ref dir, or repoRoot for worktree targets
  repoRoot: string;
  targetsFile: string;
}): Promise<TargetOverview> {
  const out: TargetOverview = {
    target: input.name,
    ref: input.ref,
    migrations: { error: "not run" },
    extensions: { error: "not run" },
    config: { error: "not run" },
    seeds: { error: "not run" },
  };

  // Extensions need no token — always attempted. Compares deployed source
  // tree hash against the target's ref (worktree targets compare vs HEAD).
  const extPromise = (async (): Promise<Dimension<ExtensionsSummary>> => {
    try {
      const report = await diffExtensions({
        targetsFile: input.targetsFile,
        targets: [input.name],
        repoRoot: input.repoRoot,
        reference: input.ref ?? "HEAD",
      });
      const summary: ExtensionsSummary = { match: 0, drift: 0, missing: 0, driftList: [], missingList: [] };
      for (const row of report.rows) {
        const cell = row.cells[input.name];
        if (!cell) continue;
        if (cell.error) {
          summary.missing++;
          summary.missingList.push(row.extension);
        } else if (cell.matchesReference) {
          summary.match++;
        } else {
          summary.drift++;
          summary.driftList.push({ name: row.extension, hint: cell.branchHint });
        }
      }
      return summary;
    } catch (e) {
      return { error: (e as Error).message };
    }
  })();

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
  const p = (rel: string) => join(input.layoutRoot, rel);

  const migPromise = (async (): Promise<Dimension<MigrationsSummary>> => {
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
      const s: MigrationsSummary = { applied: 0, pending: 0, mutated: 0, pendingList: [], mutatedList: [] };
      for (const r of results) {
        const f = r.label.replace(/^migrations\//, "");
        if (r.action === "unchanged") s.applied++;
        else if (r.action === "created") { s.pending++; s.pendingList.push(f); }
        else if (r.action === "failed") { s.mutated++; s.mutatedList.push(f); }
      }
      return s;
    } catch (e) {
      return { error: (e as Error).message };
    }
  })();

  const cfgPromise = (async (): Promise<{ config: Dimension<ChangeSummary>; seeds: Dimension<ChangeSummary> }> => {
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
        entities: new Set<EntityKind>([...CONFIG_ENTITIES, "seeds"]),
      });
      const config: ChangeSummary = { changes: 0, changeList: [] };
      const seeds: ChangeSummary = { changes: 0, changeList: [] };
      for (const r of report.results) {
        if (r.action !== "created" && r.action !== "updated") continue;
        const bucket = r.kind === "seeds" ? seeds : config;
        bucket.changes++;
        bucket.changeList.push(`${r.action === "created" ? "+" : "~"} ${r.label}`);
      }
      return { config, seeds };
    } catch (e) {
      const error = (e as Error).message;
      return { config: { error }, seeds: { error } };
    }
  })();

  const [ext, mig, cfg] = await Promise.all([extPromise, migPromise, cfgPromise]);
  out.extensions = ext;
  out.migrations = mig;
  out.config = cfg.config;
  out.seeds = cfg.seeds;
  return out;
}

// -------------------- orchestration --------------------

export interface OverviewInput {
  targetsFile: string;
  repoRoot: string;
  targets?: string[];  // restrict to these targets
  from?: string;       // promotion queue source ref (default: inferred)
  to?: string;         // promotion queue destination ref (default: inferred)
}

// Infer the promotion pair from the targets' refs: exactly two distinct refs,
// where a build_forbidden (prod-like) target pins the `to` side.
export function inferPromotionPair(
  targets: Array<{ ref: string | null; buildForbidden: boolean }>,
): { from: string; to: string } | { skipped: string } {
  const refs = [...new Set(targets.map((t) => t.ref).filter((r): r is string => r !== null))];
  if (refs.length !== 2) {
    return { skipped: `need exactly 2 distinct refs across targets to infer the pair (found ${refs.length}) — pass --from/--to` };
  }
  const prodRefs = [...new Set(targets.filter((t) => t.buildForbidden && t.ref).map((t) => t.ref!))];
  if (prodRefs.length !== 1) {
    return { skipped: "could not tell which ref is the promotion destination — pass --from/--to" };
  }
  const to = prodRefs[0]!;
  const from = refs.find((r) => r !== to)!;
  return { from, to };
}

export async function runOverview(input: OverviewInput): Promise<OverviewReport> {
  const repoRoot = resolve(input.repoRoot);
  const cfg = await loadTargets(input.targetsFile);
  const names = input.targets?.length ? input.targets : Object.keys(cfg.targets);
  const missing = names.filter((n) => !cfg.targets[n]);
  if (missing.length) throw new Error(`unknown target(s): ${missing.join(", ")}`);

  // Materialize each distinct ref once, shared across targets.
  const matCache = new Map<string, Promise<string>>();
  const materialized = (ref: string): Promise<string> => {
    let p = matCache.get(ref);
    if (!p) {
      p = materializeRef(repoRoot, ref);
      matCache.set(ref, p);
    }
    return p;
  };

  const targetChecks = names.map(async (name): Promise<TargetOverview> => {
    const t = cfg.targets[name]!;
    const ref = t.ref ?? null;
    let layoutRoot = repoRoot;
    if (ref) {
      try {
        layoutRoot = await materialized(ref);
      } catch (e) {
        const error = (e as Error).message;
        return {
          target: name,
          ref,
          migrations: { error },
          extensions: { error },
          config: { error },
          seeds: { error },
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
    });
  });

  let promotion: PromotionQueue | null = null;
  let promotionSkipped: string | undefined;
  let pair: { from: string; to: string } | { skipped: string };
  if (input.from && input.to) {
    pair = { from: input.from, to: input.to };
  } else if (input.from || input.to) {
    pair = { skipped: "--from and --to must be passed together" };
  } else {
    pair = inferPromotionPair(
      names.map((n) => ({
        ref: cfg.targets[n]!.ref ?? null,
        buildForbidden: Boolean(cfg.targets[n]!.build_forbidden),
      })),
    );
  }
  const promotionPromise = (async () => {
    if ("skipped" in pair) {
      promotionSkipped = pair.skipped;
      return;
    }
    try {
      promotion = await computePromotionQueue(repoRoot, pair.from, pair.to);
    } catch (e) {
      promotionSkipped = (e as Error).message;
    }
  })();

  const targets = await Promise.all(targetChecks);
  await promotionPromise;

  // Best-effort temp cleanup — a leaked dir in tmpdir is harmless.
  for (const p of matCache.values()) {
    p.then((dir) => rm(dir, { recursive: true, force: true })).catch(() => {});
  }

  return { targets, promotion, promotionSkipped };
}

// -------------------- rendering --------------------

function isErr<T>(d: Dimension<T>): d is { error: string } {
  return typeof (d as { error?: unknown }).error === "string";
}

function cellMigrations(d: Dimension<MigrationsSummary>): string {
  if (isErr(d)) return "⚠ unreachable";
  if (d.pending === 0 && d.mutated === 0) return `✓ ${d.applied} applied`;
  const parts = [`${d.pending} pending`];
  if (d.mutated > 0) parts.push(`${d.mutated} mutated`);
  return `✗ ${parts.join(", ")}`;
}

function cellExtensions(d: Dimension<ExtensionsSummary>): string {
  if (isErr(d)) return "⚠ unreachable";
  const total = d.match + d.drift + d.missing;
  if (d.drift === 0) return `✓ ${d.match}/${total} match`;
  return `✗ ${d.drift} behind`;
}

function cellChanges(d: Dimension<ChangeSummary>): string {
  if (isErr(d)) return "⚠ unreachable";
  return d.changes === 0 ? "✓ in sync" : `✗ ${d.changes} change${d.changes === 1 ? "" : "s"}`;
}

export function renderOverview(report: OverviewReport): string {
  const dims = ["migrations", "extensions", "config", "seeds"] as const;
  const colWidth = 20;
  const labelWidth = 14;

  const headers: string[] = [];
  const subHeaders: string[] = [];
  for (const t of report.targets) {
    headers.push(t.target);
    subHeaders.push(t.ref ? `vs ${t.ref}` : "vs worktree");
  }
  const promo = report.promotion;
  if (promo) {
    headers.push(`${short(promo.from)} → ${short(promo.to)}`);
    subHeaders.push("promotion queue");
  }

  const lines: string[] = [];
  lines.push(
    "".padEnd(labelWidth) + headers.map((h) => h.padEnd(colWidth)).join("").trimEnd(),
  );
  lines.push(
    "".padEnd(labelWidth) + subHeaders.map((h) => h.padEnd(colWidth)).join("").trimEnd(),
  );
  lines.push("");

  for (const dim of dims) {
    const cells: string[] = [];
    for (const t of report.targets) {
      switch (dim) {
        case "migrations": cells.push(cellMigrations(t.migrations)); break;
        case "extensions": cells.push(cellExtensions(t.extensions)); break;
        case "config": cells.push(cellChanges(t.config)); break;
        case "seeds": cells.push(cellChanges(t.seeds)); break;
      }
    }
    if (promo) cells.push(promotionCell(dim, promo));
    lines.push(
      `  ${dim.padEnd(labelWidth - 2)}` + cells.map((c) => c.padEnd(colWidth)).join("").trimEnd(),
    );
  }

  // Detail block: every red/⚠ cell explains itself.
  const details: string[] = [];
  for (const t of report.targets) {
    if (isErr(t.migrations)) details.push(`⚠ ${t.target} migrations: ${t.migrations.error}`);
    else {
      if (t.migrations.pendingList.length)
        details.push(`✗ ${t.target} migrations pending: ${t.migrations.pendingList.join(", ")}`);
      if (t.migrations.mutatedList.length)
        details.push(`✗ ${t.target} migrations MUTATED: ${t.migrations.mutatedList.join(", ")}`);
    }
    if (isErr(t.extensions)) details.push(`⚠ ${t.target} extensions: ${t.extensions.error}`);
    else {
      for (const d of t.extensions.driftList)
        details.push(`✗ ${t.target} extension ${d.name} differs from ${t.ref ?? "HEAD"}${d.hint ? ` — running ${d.hint}` : ""}`);
      if (t.extensions.missingList.length)
        details.push(`? ${t.target} extensions uncheckable (no _meta, or deployed commit not in local git): ${t.extensions.missingList.join(", ")}`);
    }
    if (isErr(t.config)) details.push(`⚠ ${t.target} config: ${t.config.error}`);
    else for (const c of truncate(t.config.changeList)) details.push(`✗ ${t.target} config ${c}`);
    if (isErr(t.seeds)) details.push(`⚠ ${t.target} seeds: ${t.seeds.error}`);
    else for (const c of truncate(t.seeds.changeList)) details.push(`✗ ${t.target} seeds ${c}`);
  }
  if (details.length) {
    lines.push("");
    lines.push(...details.map((d) => `  ${d}`));
  }

  lines.push("");
  if (promo) {
    lines.push(
      `  ${short(promo.from)} is ${promo.commitsAhead} commit(s) ahead of ${short(promo.to)}` +
        (promo.commitsBehind > 0
          ? ` — and ${short(promo.to)} has ${promo.commitsBehind} commit(s) not on ${short(promo.from)} (hotfix?)`
          : ""),
    );
    const promoDetails: string[] = [];
    for (const m of promo.migrations.added) promoDetails.push(`  queued migration: ${m}`);
    for (const m of promo.migrations.modified) promoDetails.push(`  ⚠ migration MODIFIED between refs: ${m}`);
    for (const m of promo.migrations.removed) promoDetails.push(`  ⚠ migration removed on ${short(promo.from)}: ${m}`);
    if (promo.extensions.length) promoDetails.push(`  queued extensions: ${promo.extensions.join(", ")}`);
    if (promoDetails.length) lines.push(...promoDetails.map((d) => `  ${d}`));
  } else if (report.promotionSkipped) {
    lines.push(`  (promotion column skipped: ${report.promotionSkipped})`);
  }

  const anyDrift = hasDrift(report);
  const anyErr = hasErrors(report);
  lines.push("");
  lines.push(
    anyDrift
      ? "  Drift detected."
      : anyErr
        ? "  No drift found, but some checks could not run."
        : "  All environments in sync.",
  );
  return lines.join("\n");
}

function short(ref: string): string {
  return ref.replace(/^origin\//, "");
}

// Keep the detail block readable when a whole collection changes at once —
// the full list is always available via --json.
function truncate(list: string[], max = 6): string[] {
  if (list.length <= max) return list;
  return [...list.slice(0, max - 1), `… and ${list.length - (max - 1)} more (see --json)`];
}

function promotionCell(dim: "migrations" | "extensions" | "config" | "seeds", p: PromotionQueue): string {
  switch (dim) {
    case "migrations": {
      const n = p.migrations.added.length;
      const warn = p.migrations.modified.length + p.migrations.removed.length;
      if (n === 0 && warn === 0) return "none";
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

export function hasDrift(report: OverviewReport): boolean {
  for (const t of report.targets) {
    if (!isErr(t.migrations) && (t.migrations.pending > 0 || t.migrations.mutated > 0)) return true;
    if (!isErr(t.extensions) && t.extensions.drift > 0) return true;
    if (!isErr(t.config) && t.config.changes > 0) return true;
    if (!isErr(t.seeds) && t.seeds.changes > 0) return true;
  }
  return false;
}

export function hasErrors(report: OverviewReport): boolean {
  return report.targets.some(
    (t) => isErr(t.migrations) || isErr(t.extensions) || isErr(t.config) || isErr(t.seeds),
  );
}
