#!/usr/bin/env node
import { Command } from "commander";
import { run } from "./runner.js";
import { formatHuman, formatJson } from "./report.js";
import { createDirectusClient } from "./http.js";
import type { ApplyOptions } from "./types.js";

const KNOWN_ENTITIES = [
  "collections",
  "fields",
  "relations",
  "roles",
  "policies",
  "permissions",
  "flows",
  "operations",
  "migrations",
  "seeds",
] as const;
type Entity = (typeof KNOWN_ENTITIES)[number];

interface CommonFlags {
  url?: string;
  token?: string;
  target?: string;
  entities: string;
  onlyCollections?: string;
  snapshotDir: string;
  configDir: string;
  registerDir: string;
  migrationsDir: string;
  seedDir: string;
  json?: boolean;
}

function parseEntities(csv: string): Set<Entity> {
  const parts = csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const set = new Set<Entity>();
  for (const p of parts) {
    if (!(KNOWN_ENTITIES as readonly string[]).includes(p)) {
      throw new Error(`unknown entity kind '${p}' (expected: ${KNOWN_ENTITIES.join(", ")})`);
    }
    set.add(p as Entity);
  }
  return set;
}

function readCommon(flags: CommonFlags): {
  url: string;
  token: string;
  target: string;
  entities: Set<Entity>;
  onlyCollections?: Set<string>;
  snapshotDir: string;
  configDir: string;
  registerDir: string;
  migrationsDir: string;
  seedDir: string;
  json: boolean;
} {
  const url = flags.url ?? process.env.DIRECTUS_URL;
  const token = flags.token ?? process.env.DIRECTUS_TOKEN;
  if (!url) throw new Error("--url or DIRECTUS_URL required");
  if (!token) throw new Error("--token or DIRECTUS_TOKEN required");
  const target = flags.target ?? new URL(url).hostname;
  const entities = parseEntities(flags.entities);
  const onlyCollections = flags.onlyCollections
    ? new Set(flags.onlyCollections.split(",").map((s) => s.trim()).filter(Boolean))
    : undefined;
  return {
    url,
    token,
    target,
    entities,
    onlyCollections,
    snapshotDir: flags.snapshotDir,
    configDir: flags.configDir,
    registerDir: flags.registerDir,
    migrationsDir: flags.migrationsDir,
    seedDir: flags.seedDir,
    json: Boolean(flags.json),
  };
}

interface ExecuteOptions {
  dryRun: boolean;
  strict?: boolean; // verify mode — any created/updated is a failure
}

async function execute(mode: ExecuteOptions, flags: CommonFlags): Promise<number> {
  const common = readCommon(flags);
  const client = createDirectusClient({ baseUrl: common.url, token: common.token });
  const opts: ApplyOptions = { dryRun: mode.dryRun, onlyCollections: common.onlyCollections };
  const report = await run({
    target: common.target,
    paths: {
      snapshotDir: common.snapshotDir,
      configDir: common.configDir,
      registerDir: common.registerDir,
    },
    migrationsDir: common.migrationsDir,
    seedDir: common.seedDir,
    client,
    opts,
    entities: common.entities,
  });
  if (common.json) {
    process.stdout.write(formatJson(report) + "\n");
  } else {
    process.stdout.write(formatHuman(report) + "\n");
  }
  if (report.counts.failed > 0) return 1;
  if (mode.strict) {
    // Verify: any drift (created/updated) means the target didn't match git.
    // `skipped` is intentional (adopted-but-unregistered raw-SQL columns,
    // register-manifest collections) — never treated as drift.
    if (report.counts.created > 0 || report.counts.updated > 0) {
      process.stderr.write(
        `verify: drift detected (${report.counts.created} would-create, ${report.counts.updated} would-update)\n`,
      );
      return 1;
    }
    // Server-side gate: any `directus_fields.type = 'unknown'` row on the
    // target means a raw-SQL column was added but never registered — either
    // via `migrations/register/<table>.json` or by a Directus-native field
    // definition. Fail fast so the miss surfaces here, not in a UI 500.
    const unknowns = await fetchUnknownFields(client);
    if (unknowns === null) {
      process.stderr.write(
        `verify: could not query directus_fields for type=unknown (raw-query endpoint unavailable?) — skipping check\n`,
      );
    } else if (unknowns.length > 0) {
      process.stderr.write(
        `verify: ${unknowns.length} field(s) have type='unknown' on target — add a register manifest or Directus field definition:\n`,
      );
      for (const u of unknowns) {
        process.stderr.write(`  ${u.collection}.${u.field}\n`);
      }
      return 1;
    }
  }
  return 0;
}

async function fetchUnknownFields(
  client: import("./types.js").DirectusClient,
): Promise<Array<{ collection: string; field: string }> | null> {
  try {
    const r = (await client.postRaw("/raw-query/execute", {
      query:
        "SELECT collection, field FROM directus_fields WHERE type = 'unknown' ORDER BY collection, field",
    })) as { success?: boolean; results?: Array<{ success?: boolean; data?: unknown[] }> };
    const inner = r?.results?.[0];
    if (!r?.success || !inner?.success) return null;
    const out: Array<{ collection: string; field: string }> = [];
    for (const row of inner.data ?? []) {
      if (row && typeof row === "object" && "collection" in row && "field" in row) {
        const rr = row as { collection: unknown; field: unknown };
        out.push({ collection: String(rr.collection), field: String(rr.field) });
      }
    }
    return out;
  } catch {
    return null;
  }
}

const program = new Command();
program
  .name("directus-deploy")
  .description(
    "Reconcile a Directus environment to the state described in directus_config/snapshot/. Per-entity, non-atomic.",
  )
  .version("0.8.0");

function attachCommon(cmd: Command): Command {
  return cmd
    .option("--url <url>", "Directus base URL (env: DIRECTUS_URL)")
    .option("--token <token>", "Directus admin token (env: DIRECTUS_TOKEN)")
    .option("--target <label>", "friendly label for logs (default: URL hostname)")
    .option(
      "--entities <csv>",
      `comma-separated subset of ${KNOWN_ENTITIES.join(",")}`,
      KNOWN_ENTITIES.join(","),
    )
    .option("--only-collections <csv>", "restrict run to these collection names")
    .option(
      "--snapshot-dir <path>",
      "path to directus_config/snapshot",
      "./directus_config/snapshot",
    )
    .option(
      "--config-dir <path>",
      "path to directus_config/collections (holds policies.json, permissions.json, roles.json, …)",
      "./directus_config/collections",
    )
    .option(
      "--register-dir <path>",
      "path to migrations/register",
      "./migrations/register",
    )
    .option(
      "--seed-dir <path>",
      "path to directus_config/seed (Tractr-style {collection, meta, data} files)",
      "./directus_config/seed",
    )
    .option(
      "--migrations-dir <path>",
      "path to migrations/*.sql (raw SQL, tracked in _directus_deploy_migrations)",
      "./migrations",
    )
    .option("--json", "emit JSON report instead of human-readable");
}

attachCommon(program.command("plan"))
  .description("Dry-run: report what would change without writing.")
  .action(async (_, cmd) => {
    process.exit(await execute({ dryRun: true }, cmd.optsWithGlobals()));
  });

attachCommon(program.command("apply"))
  .description("Apply the desired state to the target env.")
  .action(async (_, cmd) => {
    process.exit(await execute({ dryRun: false }, cmd.optsWithGlobals()));
  });

attachCommon(program.command("verify"))
  .description(
    "Post-apply drift check. Runs plan-mode and exits non-zero if any entity would be created or updated (idempotency guard for CI).",
  )
  .action(async (_, cmd) => {
    process.exit(await execute({ dryRun: true, strict: true }, cmd.optsWithGlobals()));
  });

// migrations adopt: bootstrap the tracker on an env whose migrations were
// applied via some prior mechanism. Inserts (filename, sha256) rows without
// executing any SQL. Idempotent — re-adopting is a no-op when hashes match.
const migrationsGroup = program
  .command("migrations")
  .description("migration-specific commands");

migrationsGroup
  .command("adopt")
  .description(
    "Insert current migrations/*.sql into the tracker WITHOUT running them. Use once per env when cutting over from a prior deploy mechanism.",
  )
  .option("--url <url>", "Directus base URL (env: DIRECTUS_URL)")
  .option("--token <token>", "Directus admin token (env: DIRECTUS_TOKEN)")
  .option("--target <label>", "friendly label for logs (default: URL hostname)")
  .option(
    "--migrations-dir <path>",
    "path to migrations/*.sql",
    "./migrations",
  )
  .option("--dry-run", "report what would be adopted, don't write")
  .option("--json", "emit JSON report instead of human-readable")
  .action(async (opts: {
    url?: string;
    token?: string;
    target?: string;
    migrationsDir: string;
    dryRun?: boolean;
    json?: boolean;
  }) => {
    const url = opts.url ?? process.env.DIRECTUS_URL;
    const token = opts.token ?? process.env.DIRECTUS_TOKEN;
    if (!url) throw new Error("--url or DIRECTUS_URL required");
    if (!token) throw new Error("--token or DIRECTUS_TOKEN required");
    const target = opts.target ?? new URL(url).hostname;
    const client = createDirectusClient({ baseUrl: url, token });
    const { adoptMigrations } = await import("./reconcilers/migrations.js");
    const results = await adoptMigrations({
      migrationsDir: opts.migrationsDir,
      client,
      opts: { dryRun: Boolean(opts.dryRun) },
    });
    const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
    for (const r of results) counts[r.action] += 1;
    const report = { target, results, counts };
    if (opts.json) {
      process.stdout.write(formatJson(report) + "\n");
    } else {
      process.stdout.write(formatHuman(report) + "\n");
    }
    process.exit(counts.failed > 0 ? 1 : 0);
  });

migrationsGroup
  .command("lint")
  .description(
    "Static check: every CREATE TABLE / ADD COLUMN in migrations/*.sql must be covered by a register manifest or a real (non-'unknown') snapshot field definition. No network calls.",
  )
  .option(
    "--migrations-dir <path>",
    "path to migrations/*.sql",
    "./migrations",
  )
  .option(
    "--register-dir <path>",
    "path to migrations/register",
    "./migrations/register",
  )
  .option(
    "--snapshot-dir <path>",
    "path to directus_config/snapshot",
    "./directus_config/snapshot",
  )
  .option("--json", "emit JSON output")
  .action(async (opts: {
    migrationsDir: string;
    registerDir: string;
    snapshotDir: string;
    json?: boolean;
  }) => {
    const { lintMigrations } = await import("./lint.js");
    const { violations, scanned } = await lintMigrations({
      migrationsDir: opts.migrationsDir,
      registerDir: opts.registerDir,
      snapshotDir: opts.snapshotDir,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify({ scanned, violations }, null, 2) + "\n");
    } else if (violations.length === 0) {
      process.stdout.write(`migrations lint: ${scanned} file(s) scanned, no violations.\n`);
    } else {
      process.stderr.write(
        `migrations lint: ${violations.length} violation(s) across ${scanned} file(s):\n`,
      );
      for (const v of violations) {
        process.stderr.write(`  ${v.file}: ${v.reason}\n`);
      }
    }
    process.exit(violations.length === 0 ? 0 : 1);
  });

// Snapshot commands — repo-side static checks that don't hit the network.
// Ports of scripts/lint-snapshot-refs.py (etc.) into the tool so agents and
// pre-push hooks call one binary.
const snapshotGroup = program
  .command("snapshot")
  .description("Snapshot repo-side commands (static checks, pull, dump)");

snapshotGroup
  .command("lint")
  .description(
    "Static integrity checks on directus_config/snapshot: dangling meta.group refs, bad field FKs, missing fields dirs, register-manifest pairing, migration comment semicolons.",
  )
  .option(
    "--snapshot-dir <path>",
    "path to directus_config/snapshot",
    "./directus_config/snapshot",
  )
  .option(
    "--migrations-dir <path>",
    "path to migrations",
    "./migrations",
  )
  .option(
    "--register-dir <path>",
    "path to migrations/register",
    "./migrations/register",
  )
  .option("--repo-root <path>", "repo root for tidy path printing", process.cwd())
  .option("--json", "emit JSON output")
  .action(async (opts: {
    snapshotDir: string;
    migrationsDir: string;
    registerDir: string;
    repoRoot: string;
    json?: boolean;
  }) => {
    const { lintSnapshot } = await import("./snapshot-lint.js");
    const report = await lintSnapshot({
      snapshotDir: opts.snapshotDir,
      migrationsDir: opts.migrationsDir,
      registerDir: opts.registerDir,
      repoRoot: opts.repoRoot,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else if (report.offenders.length === 0) {
      process.stdout.write(
        `snapshot lint OK — ${report.collectionsScanned} collections + migrations scanned.\n`,
      );
    } else {
      process.stderr.write(
        `snapshot lint: ${report.offenders.length} issue(s) across ${report.collectionsScanned} collections:\n`,
      );
      for (const o of report.offenders) {
        process.stderr.write(`  ${o.file}: ${o.message}\n`);
      }
    }
    process.exit(report.offenders.length === 0 ? 0 : 1);
  });

snapshotGroup
  .command("pull")
  .description(
    "Pull missing fields + relations from a Directus target and write them into directus_config/snapshot. Auto-detects drift (collections with a schema block but no fields dir). Drops phantom snapshot files that 403/404 on the target.",
  )
  .argument("[collections...]", "explicit collection names; default: auto-detect drift")
  .option("--url <url>", "Directus base URL (env: DIRECTUS_URL)")
  .option("--token <token>", "Directus admin token (env: DIRECTUS_TOKEN)")
  .option(
    "--snapshot-dir <path>",
    "path to directus_config/snapshot",
    "./directus_config/snapshot",
  )
  .option("--dry-run", "list drift + counts, don't write")
  .option("--json", "emit JSON")
  .action(async (collections: string[], opts: {
    url?: string;
    token?: string;
    snapshotDir: string;
    dryRun?: boolean;
    json?: boolean;
  }) => {
    const url = opts.url ?? process.env.DIRECTUS_URL;
    const token = opts.token ?? process.env.DIRECTUS_TOKEN;
    if (!url) throw new Error("--url or DIRECTUS_URL required");
    if (!token) throw new Error("--token or DIRECTUS_TOKEN required");
    const client = createDirectusClient({ baseUrl: url, token });
    const { pullSnapshot } = await import("./snapshot-pull.js");
    const results = await pullSnapshot({
      snapshotDir: opts.snapshotDir,
      client,
      targets: collections.length ? collections : undefined,
      dryRun: Boolean(opts.dryRun),
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(results, null, 2) + "\n");
    } else if (results.length === 0) {
      process.stdout.write("✔ no drift — every data collection in snapshot has a fields dir\n");
    } else {
      for (const r of results) {
        switch (r.action) {
          case "pulled":
          case "dry-run": {
            const skip = r.fieldsSkipped ? ` (skipped ${r.fieldsSkipped} unregistered col)` : "";
            process.stdout.write(
              `  ${r.action === "dry-run" ? "would pull" : "pulled"} ${r.collection}: ${r.fieldsWritten} field(s), ${r.relationsWritten} relation(s)${skip}\n`,
            );
            break;
          }
          case "phantom":
            process.stderr.write(
              `  ${r.collection}: NOT ON target — ${r.droppedPath ? `dropped ${r.droppedPath}` : "no snapshot file to drop"}\n`,
            );
            break;
          case "failed":
            process.stderr.write(`  ${r.collection}: FAILED — ${r.error}\n`);
            break;
        }
      }
    }
    const anyFailed = results.some((r) => r.action === "failed");
    process.exit(anyFailed ? 1 : 0);
  });

const extensionsGroup = program
  .command("extensions")
  .description("Extension deploy over plain SSH (no gcloud, no service account)");

extensionsGroup
  .command("push")
  .description(
    "Build extensions/<name> locally and rsync to the target VM. Atomically swaps dist/ so EXTENSIONS_AUTO_RELOAD picks it up, then verifies /<name>/_meta.",
  )
  .argument("[names...]", "extensions to push (default: --all)")
  .requiredOption("--target <env>", "target env name from the targets file")
  .option("--targets-file <path>", "path to targets JSON", "./directus-deploy.targets.json")
  .option("--repo-root <path>", "repo root (default: cwd)", process.cwd())
  .option("--all", "push every extension (respects --targets-file)")
  .option("--skip-build", "skip 'npm run build' — assume dist/ is up to date")
  .action(async (names: string[], opts: {
    target: string;
    targetsFile: string;
    repoRoot: string;
    all?: boolean;
    skipBuild?: boolean;
  }) => {
    const { pushExtension } = await import("./extensions.js");
    let list = names;
    if ((!list || list.length === 0) && opts.all) {
      const { readdir } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const entries = await readdir(join(opts.repoRoot, "extensions"));
      list = entries.filter((e) => existsSync(join(opts.repoRoot, "extensions", e, "package.json"))).sort();
    }
    if (!list || list.length === 0) {
      process.stderr.write("no extensions to push. Pass names or --all.\n");
      process.exit(2);
    }
    let anyFailed = false;
    for (const name of list) {
      try {
        process.stdout.write(`==> ${name} → ${opts.target}\n`);
        const r = await pushExtension({
          extensionName: name,
          target: opts.target,
          targetsFile: opts.targetsFile,
          repoRoot: opts.repoRoot,
          skipBuild: Boolean(opts.skipBuild),
        });
        const verify = r.verifiedCommit
          ? r.verifiedCommit.startsWith(r.sourceCommit)
            ? "✓ verified"
            : `✗ /_meta reports ${r.verifiedCommit.slice(0, 8)}, expected ${r.sourceCommit.slice(0, 8)}`
          : "⚠ /_meta not readable — verify manually";
        process.stdout.write(
          `    build=${r.buildDurationMs}ms rsync=${r.transportDurationMs}ms commit=${r.sourceCommit.slice(0, 8)} ${verify}\n`,
        );
        if (r.verifiedCommit && !r.verifiedCommit.startsWith(r.sourceCommit)) anyFailed = true;
      } catch (e) {
        anyFailed = true;
        process.stderr.write(`    FAILED: ${(e as Error).message}\n`);
      }
    }
    process.exit(anyFailed ? 1 : 0);
  });

extensionsGroup
  .command("status")
  .description(
    "Query /<name>/_meta for each extension on the target and print the deployed sourceCommit + buildTime.",
  )
  .argument("[names...]", "extensions to check (default: all under ./extensions)")
  .requiredOption("--target <env>", "target env name from the targets file")
  .option("--targets-file <path>", "path to targets JSON", "./directus-deploy.targets.json")
  .option("--repo-root <path>", "repo root (default: cwd)", process.cwd())
  .option("--json", "emit JSON")
  .action(async (names: string[], opts: {
    target: string;
    targetsFile: string;
    repoRoot: string;
    json?: boolean;
  }) => {
    const { statusExtensions } = await import("./extensions.js");
    const rows = await statusExtensions({
      target: opts.target,
      targetsFile: opts.targetsFile,
      extensions: names.length ? names : undefined,
      repoRoot: opts.repoRoot,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    } else {
      for (const row of rows) {
        const commit = row.sourceCommit ? row.sourceCommit.slice(0, 8) : "-".repeat(8);
        const err = row.error ? ` (${row.error})` : "";
        process.stdout.write(`  ${row.name.padEnd(24)} ${commit}${err}\n`);
      }
    }
    process.exit(0);
  });

extensionsGroup
  .command("diff")
  .description(
    "Cross-env deploy matrix: one row per extension, one column per target. Shows deployed sourceCommit + whether it's reachable from a reference branch (default: origin/master). Surfaces WIP-on-test, staging-lag, unmerged branches in one call.",
  )
  .argument("[names...]", "extensions to check (default: all)")
  .option("--targets <csv>", "restrict to these targets (default: every target in the file)")
  .option("--targets-file <path>", "path to targets JSON", "./directus-deploy.targets.json")
  .option("--reference <ref>", "branch ref to check reachability against", "origin/master")
  .option("--repo-root <path>", "repo root (default: cwd)", process.cwd())
  .option("--json", "emit JSON")
  .action(async (names: string[], opts: {
    targets?: string;
    targetsFile: string;
    reference: string;
    repoRoot: string;
    json?: boolean;
  }) => {
    const { diffExtensions, renderDiff } = await import("./extensions.js");
    const report = await diffExtensions({
      targetsFile: opts.targetsFile,
      reference: opts.reference,
      repoRoot: opts.repoRoot,
      extensions: names.length ? names : undefined,
      targets: opts.targets ? opts.targets.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(renderDiff(report) + "\n");
    }
    const drift = report.rows.some((r) =>
      Object.values(r.cells).some((c) => c.sourceCommit && !c.onReference),
    );
    process.exit(drift ? 1 : 0);
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`directus-deploy: ${(e as Error).message}\n`);
  process.exit(2);
});
