#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { run } from "./runner.js";
import { formatHuman, formatJson } from "./report.js";
import { createDirectusClient } from "./http.js";
import type { ApplyOptions } from "./types.js";

// Auto-load .env from cwd so `npx directus-deploy diff --target test` works
// without asking every user to remember `set -a; source .env; set +a`.
// Never overrides existing process.env — shell always wins.
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
loadDotenv(".env");

// Resolve a named target (e.g. "test", "staging", "prod") from
// directus-deploy.targets.json into { url, token }. Returns null if the name
// doesn't match an entry — callers then fall through to --url/--token.
//
// Token env var:
//   - explicit per-target `token_env` field, else
//   - DIRECTUS_<UPPER>_TOKEN convention (e.g. DIRECTUS_TEST_TOKEN)
function resolveTargetCredentials(
  name: string | undefined,
  targetsFile: string,
): { url: string; token: string; label: string } | null {
  if (!name) return null;
  if (!existsSync(targetsFile)) return null;
  let parsed: { targets?: Record<string, { base_url?: string; token_env?: string }> };
  try {
    parsed = JSON.parse(readFileSync(targetsFile, "utf8"));
  } catch {
    return null;
  }
  const entry = parsed.targets?.[name];
  if (!entry?.base_url) return null;
  const tokenEnv = entry.token_env ?? `DIRECTUS_${name.toUpperCase()}_TOKEN`;
  const token = process.env[tokenEnv];
  if (!token) {
    throw new Error(
      `target '${name}' resolved from ${targetsFile}, but ${tokenEnv} is not set in env`,
    );
  }
  return { url: entry.base_url, token, label: name };
}

function resolveConnection(opts: {
  url?: string;
  token?: string;
  target?: string;
  targetsFile?: string;
}): { url: string; token: string; target: string } {
  let url = opts.url ?? process.env.DIRECTUS_URL;
  let token = opts.token ?? process.env.DIRECTUS_TOKEN;
  let label = opts.target;
  const targetsFile = opts.targetsFile ?? "./directus-deploy.targets.json";
  if (!url || !token) {
    const r = resolveTargetCredentials(opts.target, targetsFile);
    if (r) {
      url = url ?? r.url;
      token = token ?? r.token;
      label = label ?? r.label;
    }
  }
  if (!url) {
    throw new Error("--url or DIRECTUS_URL required (or --target <name> matching targets file)");
  }
  if (!token) {
    throw new Error("--token or DIRECTUS_TOKEN required (or --target <name> matching targets file)");
  }
  return { url, token, target: label ?? new URL(url).hostname };
}

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
  targetsFile: string;
  entities: string;
  onlyCollections?: string;
  snapshotDir: string;
  configDir: string;
  registerDir: string;
  migrationsDir: string;
  extensionsDir: string;
  includeExtensions: boolean;
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
  extensionsDir: string;
  includeExtensions: boolean;
  seedDir: string;
  json: boolean;
} {
  const { url, token, target } = resolveConnection(flags);
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
    extensionsDir: flags.extensionsDir,
    includeExtensions: flags.includeExtensions,
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
    extensionsDir: common.extensionsDir,
    includeExtensions: common.includeExtensions,
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
    // Server-side gate: a column that exists in the database with no
    // directus_fields row was added by raw SQL and never registered — via
    // `migrations/register/<table>.json` or a Directus-native field
    // definition. Fail fast so the miss surfaces here, not in a UI 500.
    const unknowns = await fetchUnknownFields(client);
    if ("error" in unknowns) {
      // A backstop that cannot run is a failure, not a footnote. Reporting
      // this as a skip is what let the check sit broken indefinitely.
      process.stderr.write(
        `verify: could not read /fields to check for type='unknown': ${unknowns.error}\n`,
      );
      return 1;
    }
    // fetchUnknownFields already narrows to columns with no directus_fields
    // row, so anything here is a raw-SQL column registered by nothing —
    // regardless of which collection it sits in.
    if (unknowns.fields.length > 0) {
      process.stderr.write(
        `verify: ${unknowns.fields.length} column(s) exist in the database with no directus_fields row — add a register manifest or a Directus field definition:\n`,
      );
      for (const u of unknowns.fields) {
        process.stderr.write(`  ${u.collection}.${u.field}\n`);
      }
      return 1;
    }
  }
  return 0;
}

// `type` is NOT a column on directus_fields — that table stores meta only
// (id, collection, field, special, interface, options, …). Directus computes
// `type` from DB introspection and exposes it on GET /fields. The previous
// implementation queried `directus_fields WHERE type = 'unknown'` over
// raw-query, which always failed with `column "type" does not exist` and was
// swallowed into "raw-query endpoint unavailable?". The check therefore never
// ran, on any target, since it was written — while reporting success.
//
// Returns null only when the field list genuinely cannot be read; the caller
// treats that as a hard failure rather than a silent skip.
async function fetchUnknownFields(
  client: import("./types.js").DirectusClient,
): Promise<{ fields: Array<{ collection: string; field: string }> } | { error: string }> {
  let raw: unknown;
  try {
    raw = await client.get("/fields");
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!Array.isArray(raw)) {
    return { error: `GET /fields returned ${typeof raw}, expected an array` };
  }
  const out: Array<{ collection: string; field: string }> = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rr = row as { collection?: unknown; field?: unknown; type?: unknown; meta?: unknown };
    if (rr.type !== "unknown") continue;
    // type=unknown alone is not a miss. Directus reports it for any column it
    // cannot map — pgvector embeddings and tstzrange periods are permanently
    // in that state and there is nothing to fix about them. What distinguishes
    // a real miss is the absence of a directus_fields row, which the API
    // surfaces as meta=null. Verified against prod: listings.embedding and the
    // three .period columns are registered (meta present) and unmappable;
    // categories.embedding has meta=null and is genuinely registered by
    // nothing.
    if (rr.meta !== null && rr.meta !== undefined) continue;
    out.push({ collection: String(rr.collection), field: String(rr.field) });
  }
  out.sort((a, b) =>
    a.collection === b.collection
      ? a.field.localeCompare(b.field)
      : a.collection.localeCompare(b.collection),
  );
  return { fields: out };
}

const program = new Command();
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };
program
  .name("directus-deploy")
  .description(
    "Reconcile a Directus environment to the state described in directus_config/snapshot/. Per-entity, non-atomic.",
  )
  .version(pkg.version)
  .addHelpText(
    "after",
    `
AGENT QUICKSTART (sandboxed callers: everything below is HTTPS-only — no SSH,
no gsutil, no gcloud needed; credentials come from env by convention):

  Wake a sleeping env (needs control_url in targets + DIRECTUS_<T>_INVOKER_KEY_B64):
    directus-deploy vm start --target test        # no-op if healthy, else boots + waits

  Is the env in sync with its branch?
    directus-deploy overview --targets test --json

  Deploy config/seeds from the CURRENT CHECKOUT (check out the right ref first!):
    directus-deploy apply --target test --entities collections,fields,relations,roles,policies,permissions,flows,operations,seeds
    (never auto-apply raw-SQL migrations to shared envs — use 'migrations lint' to check them)

  EXTENSION DEPLOY MODEL — one rule: new builds enter ONLY at test; staging/prod
  replay the archived artifact (byte-identical, sha-named, first-write-wins):
    build+deploy to test (also archives to the bucket; no SSH):
      directus-deploy extensions push <name> --target test --via control
    put the SAME tested build on staging/prod (never rebuilds; refuses if unarchived):
      directus-deploy extensions promote <name> --target staging   # checkout picks the sha

  Verify what's actually running:
    directus-deploy extensions status --target test

Every command supports --help and fails with the exact env var or targets-file
field it is missing. Legacy SSH paths (extensions push without --publish,
promote without --via control) require ssh/rsync/gsutil binaries and network
egress on port 22 — unavailable in most agent sandboxes.`,
  );

function attachCommon(cmd: Command): Command {
  return cmd
    .option("--url <url>", "Directus base URL (env: DIRECTUS_URL)")
    .option("--token <token>", "Directus admin token (env: DIRECTUS_TOKEN)")
    .option(
      "--target <name>",
      "target name — resolved from targets file (base_url + DIRECTUS_<UPPER>_TOKEN); also used as log label",
    )
    .option(
      "--targets-file <path>",
      "path to targets JSON",
      "./directus-deploy.targets.json",
    )
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
    .option(
      "--extensions-dir <path>",
      "root scanned for <name>/migrations/*.sql when --include-extensions",
      "./extensions",
    )
    .option(
      "--include-extensions",
      "also scan extensions/*/migrations/*.sql (tracker keys: ext/<name>/<file>)",
      true,
    )
    .option(
      "--no-include-extensions",
      "skip extensions/*/migrations/*.sql (root only)",
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
  .option(
    "--no-verify",
    "skip the post-apply verify pass (default: run verify after apply, exit non-zero on residual drift)",
  )
  .action(async (_, cmd) => {
    const flags = cmd.optsWithGlobals() as CommonFlags & { verify?: boolean };
    const applyExit = await execute({ dryRun: false }, flags);
    if (applyExit !== 0) process.exit(applyExit);
    // commander's --no-<flag> sets `verify: false`; default (`verify` absent
    // or true) means run the post-apply verify.
    if (flags.verify === false) process.exit(0);
    process.stdout.write("\n--- post-apply verify ---\n");
    process.exit(await execute({ dryRun: true, strict: true }, flags));
  });

attachCommon(program.command("verify"))
  .description(
    "Post-apply drift check. Runs plan-mode and exits non-zero if any entity would be created or updated (idempotency guard for CI).",
  )
  .action(async (_, cmd) => {
    process.exit(await execute({ dryRun: true, strict: true }, cmd.optsWithGlobals()));
  });

// Unified diff: orchestrates migrations status + extensions diff + config
// dry-run against a single target. Exits non-zero on any drift.
program
  .command("diff")
  .description(
    "Full drift check for a target: migrations, extensions, and config. Exit 1 on any drift, exit 2 if target unreachable.",
  )
  .option("--url <url>", "Directus base URL (env: DIRECTUS_URL)")
  .option("--token <token>", "Directus admin token (env: DIRECTUS_TOKEN)")
  .option(
    "--target <name>",
    "target name — resolved from targets file (base_url + DIRECTUS_<UPPER>_TOKEN)",
  )
  .option(
    "--targets-file <path>",
    "path to targets JSON",
    "./directus-deploy.targets.json",
  )
  .option("--reference <ref>", "git ref to diff extensions against", "origin/develop")
  .option(
    "--snapshot-dir <path>",
    "path to directus_config/snapshot",
    "./directus_config/snapshot",
  )
  .option(
    "--config-dir <path>",
    "path to directus_config/collections",
    "./directus_config/collections",
  )
  .option(
    "--register-dir <path>",
    "path to migrations/register",
    "./migrations/register",
  )
  .option(
    "--seed-dir <path>",
    "path to directus_config/seed",
    "./directus_config/seed",
  )
  .option("--migrations-dir <path>", "path to migrations/*.sql", "./migrations")
  .option(
    "--extensions-dir <path>",
    "root scanned for <name>/migrations/*.sql",
    "./extensions",
  )
  .option(
    "--include-extensions",
    "also scan extensions/*/migrations/*.sql",
    true,
  )
  .option("--no-include-extensions", "skip extensions/*/migrations/*.sql (root only)")
  .option("--json", "emit JSON summary")
  .action(async (opts: {
    url?: string;
    token?: string;
    target?: string;
    targetsFile: string;
    reference: string;
    snapshotDir: string;
    configDir: string;
    registerDir: string;
    seedDir: string;
    migrationsDir: string;
    extensionsDir: string;
    includeExtensions: boolean;
    json?: boolean;
  }) => {
    if (!opts.target) {
      throw new Error("--target <name> required for diff (used to look up base_url + token)");
    }
    const { url, token, target } = resolveConnection(opts);
    const client = createDirectusClient({ baseUrl: url, token });

    // 1) Migrations
    const { reconcileMigrations } = await import("./reconcilers/migrations.js");
    const migResults = await reconcileMigrations({
      migrationsDir: opts.migrationsDir,
      extensionsDir: opts.extensionsDir,
      includeExtensions: opts.includeExtensions,
      client,
      opts: { dryRun: true },
    });
    const migUnreachable = migResults.length === 1 && migResults[0]?.label === "migrations";
    let migApplied = 0, migPending = 0, migMutated = 0;
    const migPendingList: string[] = [];
    const migMutatedList: string[] = [];
    if (!migUnreachable) {
      for (const r of migResults) {
        const f = r.label.replace(/^migrations\//, "");
        if (r.action === "unchanged") migApplied++;
        else if (r.action === "created") { migPending++; migPendingList.push(f); }
        else if (r.action === "failed") { migMutated++; migMutatedList.push(f); }
      }
    }

    // 2) Extensions
    const { diffExtensions } = await import("./extensions.js");
    const extReport = await diffExtensions({
      targetsFile: opts.targetsFile,
      targets: [target],
      repoRoot: process.cwd(),
      reference: opts.reference,
    });
    let extMatch = 0, extDrift = 0, extMissing = 0;
    const extDriftList: Array<{ name: string; hint: string | null }> = [];
    const extMissingList: string[] = [];
    for (const row of extReport.rows) {
      const cell = row.cells[target];
      if (!cell) continue;
      if (cell.error) {
        extMissing++;
        extMissingList.push(row.extension);
      } else if (cell.matchesReference) {
        extMatch++;
      } else {
        extDrift++;
        extDriftList.push({ name: row.extension, hint: cell.branchHint });
      }
    }

    // 3) Config
    const cfgReport = await run({
      target,
      paths: {
        snapshotDir: opts.snapshotDir,
        configDir: opts.configDir,
        registerDir: opts.registerDir,
      },
      migrationsDir: opts.migrationsDir,
      extensionsDir: opts.extensionsDir,
      includeExtensions: opts.includeExtensions,
      seedDir: opts.seedDir,
      client,
      opts: { dryRun: true },
      entities: new Set([
        "collections",
        "fields",
        "relations",
        "roles",
        "policies",
        "permissions",
        "flows",
        "operations",
        "seeds",
      ]),
    });
    const cfgByKind: Record<string, { created: number; updated: number }> = {};
    const cfgChangeList: string[] = [];
    for (const r of cfgReport.results) {
      if (r.kind === "migrations") continue;
      if (!cfgByKind[r.kind]) cfgByKind[r.kind] = { created: 0, updated: 0 };
      if (r.action === "created") { cfgByKind[r.kind]!.created++; cfgChangeList.push(`+ ${r.label}`); }
      else if (r.action === "updated") { cfgByKind[r.kind]!.updated++; cfgChangeList.push(`~ ${r.label}`); }
    }
    const cfgChangeCount = Object.values(cfgByKind).reduce((s, v) => s + v.created + v.updated, 0);

    const summary = {
      target,
      migrations: migUnreachable
        ? { unreachable: true }
        : { applied: migApplied, pending: migPending, mutated: migMutated, pendingList: migPendingList, mutatedList: migMutatedList },
      extensions: {
        reference: opts.reference,
        match: extMatch,
        drift: extDrift,
        missing: extMissing,
        driftList: extDriftList,
        missingList: extMissingList,
      },
      config: {
        totalChanges: cfgChangeCount,
        byKind: cfgByKind,
        changeList: cfgChangeList,
      },
    };

    if (opts.json) {
      process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    } else {
      const lines: string[] = [];
      lines.push(`diff: ${target}`);
      lines.push("");
      // migrations
      if (migUnreachable) {
        lines.push("migrations   ⚠ target unreachable (raw-query endpoint missing)");
      } else {
        const mstat = migPending === 0 && migMutated === 0 ? "✓" : "✗";
        lines.push(`migrations   ${migApplied} applied · ${migPending} pending · ${migMutated} mutated                 ${mstat}`);
        for (const f of migPendingList) lines.push(`             [ ] ${f}`);
        for (const f of migMutatedList) lines.push(`             [!] ${f}`);
      }
      // extensions
      const estat = extDrift === 0 ? "✓" : "✗";
      lines.push(`extensions   ${extMatch} match · ${extDrift} drift · ${extMissing} unreachable (vs ${opts.reference})   ${estat}`);
      for (const { name, hint } of extDriftList) lines.push(`             ✗ ${name}${hint ? `  — running ${hint}` : ""}`);
      for (const name of extMissingList) lines.push(`             ? ${name}  — /_meta unreachable (hook-only bundle?)`);
      // config
      const cstat = cfgChangeCount === 0 ? "✓" : "✗";
      const byKindStr = Object.entries(cfgByKind)
        .filter(([, v]) => v.created + v.updated > 0)
        .map(([k, v]) => `${k} ${v.created + v.updated}`)
        .join(" · ") || "no changes";
      lines.push(`config       ${byKindStr}                                     ${cstat}`);
      for (const c of cfgChangeList) lines.push(`             ${c}`);
      lines.push("");
      const drift = migPending + migMutated + extDrift + cfgChangeCount;
      lines.push(drift === 0 ? "In sync." : `Drift detected (${drift} item(s)).`);
      process.stdout.write(lines.join("\n") + "\n");
    }

    if (migUnreachable) process.exit(2);
    if (migPending + migMutated + extDrift + cfgChangeCount > 0) process.exit(1);
    process.exit(0);
  });

// overview: the full deployment matrix in one command — every target compared
// against the git ref it deploys from (targets file `ref` field), plus a
// promotion-queue column (develop → master). Exit 1 on drift, 2 when a check
// could not run, 0 when everything is in sync. The promotion column is
// informational and never affects the exit code.
program
  .command("overview")
  .description(
    "Deployment matrix: each target vs its `ref` (from the targets file) across migrations/extensions/config/seeds, plus the promotion queue between refs. Assumes the canonical repo layout (directus_config/, migrations/, extensions/).",
  )
  .option(
    "--targets-file <path>",
    "path to targets JSON",
    "./directus-deploy.targets.json",
  )
  .option("--targets <csv>", "restrict to these targets (default: every target in the file)")
  .option("--repo-root <path>", "repo root (default: cwd)", process.cwd())
  .option("--from <ref>", "promotion queue source ref (default: inferred from target refs)")
  .option("--to <ref>", "promotion queue destination ref (default: inferred from target refs)")
  .option("--json", "emit JSON report instead of the matrix")
  .action(async (opts: {
    targetsFile: string;
    targets?: string;
    repoRoot: string;
    from?: string;
    to?: string;
    json?: boolean;
  }) => {
    const { runOverview, renderOverview, hasDrift, hasErrors } = await import("./overview.js");
    const report = await runOverview({
      targetsFile: opts.targetsFile,
      repoRoot: opts.repoRoot,
      targets: opts.targets ? opts.targets.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      from: opts.from,
      to: opts.to,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(renderOverview(report) + "\n");
    }
    if (hasDrift(report)) process.exit(1);
    if (hasErrors(report)) process.exit(2);
    process.exit(0);
  });

// vm: start/stop/status of a target's VM via its token-gated control endpoint
// (deploy cloudfunctions/vm-control once per controllable instance). Lets
// agents and laptops wake a sleeping test box without GitHub Actions or GCP
// credentials. `start` waits until <base_url>/server/health answers.
program
  .command("vm")
  .description(
    "Control a target's VM through its control_url endpoint: status | start | stop. `start` polls /server/health until healthy. Requires control_url in the targets file + DIRECTUS_<TARGET>_CONTROL_TOKEN in env.",
  )
  .argument("<action>", "status | start | stop")
  .requiredOption("--target <name>", "target name from the targets file")
  .option(
    "--targets-file <path>",
    "path to targets JSON",
    "./directus-deploy.targets.json",
  )
  .option("--wait-timeout <seconds>", "start: how long to wait for health", "300")
  .option("--json", "emit JSON")
  .action(async (action: string, opts: {
    target: string;
    targetsFile: string;
    waitTimeout: string;
    json?: boolean;
  }) => {
    if (!["status", "start", "stop"].includes(action)) {
      process.stderr.write(`unknown action '${action}' (status | start | stop)\n`);
      process.exit(2);
    }
    const { runVm } = await import("./vm.js");
    process.exit(
      await runVm({
        action: action as "status" | "start" | "stop",
        target: opts.target,
        targetsFile: opts.targetsFile,
        waitTimeoutMs: Number(opts.waitTimeout) * 1000,
        json: Boolean(opts.json),
      }),
    );
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
  .option(
    "--target <name>",
    "target name — resolved from targets file (base_url + DIRECTUS_<UPPER>_TOKEN)",
  )
  .option(
    "--targets-file <path>",
    "path to targets JSON",
    "./directus-deploy.targets.json",
  )
  .option(
    "--migrations-dir <path>",
    "path to migrations/*.sql",
    "./migrations",
  )
  .option(
    "--extensions-dir <path>",
    "root scanned for <name>/migrations/*.sql when --include-extensions",
    "./extensions",
  )
  .option(
    "--include-extensions",
    "also scan extensions/*/migrations/*.sql (tracker keys: ext/<name>/<file>)",
    true,
  )
  .option("--no-include-extensions", "skip extensions/*/migrations/*.sql (root only)")
  .option("--dry-run", "report what would be adopted, don't write")
  .option("--json", "emit JSON report instead of human-readable")
  .action(async (opts: {
    url?: string;
    token?: string;
    target?: string;
    targetsFile: string;
    migrationsDir: string;
    extensionsDir: string;
    includeExtensions: boolean;
    dryRun?: boolean;
    json?: boolean;
  }) => {
    const { url, token, target } = resolveConnection(opts);
    const client = createDirectusClient({ baseUrl: url, token });
    const { adoptMigrations } = await import("./reconcilers/migrations.js");
    const results = await adoptMigrations({
      migrationsDir: opts.migrationsDir,
      extensionsDir: opts.extensionsDir,
      includeExtensions: opts.includeExtensions,
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
  .command("status")
  .description(
    "Report which migrations/*.sql are applied on the target vs pending. Exit 1 if any pending or mutated files. Exit 2 if target unreachable.",
  )
  .option("--url <url>", "Directus base URL (env: DIRECTUS_URL)")
  .option("--token <token>", "Directus admin token (env: DIRECTUS_TOKEN)")
  .option(
    "--target <name>",
    "target name — resolved from targets file (base_url + DIRECTUS_<UPPER>_TOKEN)",
  )
  .option(
    "--targets-file <path>",
    "path to targets JSON",
    "./directus-deploy.targets.json",
  )
  .option(
    "--migrations-dir <path>",
    "path to migrations/*.sql",
    "./migrations",
  )
  .option(
    "--extensions-dir <path>",
    "root scanned for <name>/migrations/*.sql when --include-extensions",
    "./extensions",
  )
  .option(
    "--include-extensions",
    "also scan extensions/*/migrations/*.sql (tracker keys: ext/<name>/<file>)",
    true,
  )
  .option("--no-include-extensions", "skip extensions/*/migrations/*.sql (root only)")
  .option("--json", "emit JSON output instead of human-readable")
  .action(async (opts: {
    url?: string;
    token?: string;
    target?: string;
    targetsFile: string;
    migrationsDir: string;
    extensionsDir: string;
    includeExtensions: boolean;
    json?: boolean;
  }) => {
    const { url, token, target } = resolveConnection(opts);
    const client = createDirectusClient({ baseUrl: url, token });
    const { reconcileMigrations } = await import("./reconcilers/migrations.js");
    const results = await reconcileMigrations({
      migrationsDir: opts.migrationsDir,
      extensionsDir: opts.extensionsDir,
      includeExtensions: opts.includeExtensions,
      client,
      opts: { dryRun: true },
    });

    // Detect unreachable target: reconciler emits a single skipped result
    // with label "migrations" (not "migrations/<file>") when /raw-query/execute
    // is missing.
    const unreachable = results.length === 1 && results[0]?.label === "migrations";
    if (unreachable) {
      const reason = results[0]?.reason ?? "target unreachable";
      if (opts.json) {
        process.stdout.write(JSON.stringify({ target, unreachable: true, reason }, null, 2) + "\n");
      } else {
        process.stderr.write(`migrations status: ${target}: ${reason}\n`);
      }
      process.exit(2);
    }

    const applied: string[] = [];
    const pending: string[] = [];
    const mutated: Array<{ file: string; reason: string }> = [];
    const empty: string[] = [];
    for (const r of results) {
      const file = r.label.replace(/^migrations\//, "");
      if (r.action === "unchanged") applied.push(file);
      else if (r.action === "created") pending.push(file);
      else if (r.action === "failed") mutated.push({ file, reason: r.reason ?? "unknown" });
      else if (r.action === "skipped") empty.push(file);
    }

    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ target, applied, pending, mutated, empty }, null, 2) + "\n",
      );
    } else {
      const out: string[] = [];
      out.push(`migrations status: ${target}`);
      out.push("");
      const all = [...applied.map((f) => ({ f, mark: "[X]" })), ...pending.map((f) => ({ f, mark: "[ ]" }))];
      all.sort((a, b) => a.f.localeCompare(b.f));
      for (const { f, mark } of all) out.push(`  ${mark} ${f}`);
      for (const m of mutated) out.push(`  [!] ${m.file}  — ${m.reason}`);
      out.push("");
      out.push(`Applied: ${applied.length}   Pending: ${pending.length}   Mutated: ${mutated.length}`);
      if (empty.length > 0) out.push(`(${empty.length} empty file(s) skipped)`);
      process.stdout.write(out.join("\n") + "\n");
    }

    if (mutated.length > 0 || pending.length > 0) process.exit(1);
    process.exit(0);
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
    "Build extensions/<name> and DEPLOY it to the target. Deploying is two uploads of one tarball: (1) --publish archives it to the artifact bucket under its source-sha — this is what makes the build promotable to staging/prod later; (2) the install itself. Transport: --via ssh (default; rsync + atomic swap) or --via control (no SSH: publish + install through the target's control function; implies --publish). Always verifies /<name>/_meta afterwards. New code enters ONLY via push to test; higher envs receive the archived artifact via `promote`.",
  )
  .argument("[names...]", "extensions to push (default: --all)")
  .requiredOption("--target <env>", "target env name from the targets file")
  .option("--targets-file <path>", "path to targets JSON", "./directus-deploy.targets.json")
  .option("--repo-root <path>", "repo root (default: cwd)", process.cwd())
  .option("--all", "push every extension (respects --targets-file)")
  .option("--skip-build", "skip 'npm run build' — assume dist/ is up to date")
  .option("--publish", "also publish an immutable artifact to gs://<artifact_bucket>/<name>/<sha>.tgz (build-once/promote-many)")
  .option(
    "--via <transport>",
    "ssh (default): rsync/ssh directly to the VM. control: publish the artifact and install it through the target's control_url function — full deploy with no SSH egress (implies --publish)",
    "ssh",
  )
  .option("--allow-dirty", "permit publish from a dirty worktree (artifact won't be reproducible; never for prod)")
  .option("--force", "overwrite an existing artifact (breaks first-write-wins byte-identity — use with care)")
  .action(async (names: string[], opts: {
    target: string;
    targetsFile: string;
    repoRoot: string;
    all?: boolean;
    skipBuild?: boolean;
    publish?: boolean;
    via: string;
    allowDirty?: boolean;
    force?: boolean;
  }) => {
    if (!["ssh", "control"].includes(opts.via)) {
      process.stderr.write(`unknown --via '${opts.via}' (ssh | control)\n`);
      process.exit(2);
    }
    const { pushExtension, shaMatch } = await import("./extensions.js");
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
          publish: Boolean(opts.publish) || opts.via === "control", // control transport deploys from the bucket
          via: opts.via as "ssh" | "control",
          allowDirty: Boolean(opts.allowDirty),
          force: Boolean(opts.force),
        });
        const verify = r.verifiedCommit
          ? shaMatch(r.verifiedCommit, r.sourceCommit)
            ? "✓ verified"
            : `✗ /_meta reports ${r.verifiedCommit.slice(0, 8)}, expected ${r.sourceCommit.slice(0, 8)}`
          : "⚠ /_meta not readable — verify manually";
        const pub = r.artifact
          ? ` published=${r.artifact.alreadyPublished ? "reused" : "new"} sha=${r.artifact.sha256.slice(0, 12)}`
          : "";
        process.stdout.write(
          `    build=${r.buildDurationMs}ms rsync=${r.transportDurationMs}ms commit=${r.sourceCommit.slice(0, 8)}${pub} ${verify}\n`,
        );
        if (r.verifiedCommit && !shaMatch(r.verifiedCommit, r.sourceCommit)) anyFailed = true;
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
    "Cross-env content-equivalence matrix: one row per extension, one column per target. Compares the git tree hash of extensions/<name>/ at the deployed sourceCommit vs the reference ref (default: origin/develop). Immune to squash-merge SHA orphaning and branch history rewrites — same source tree = ✓, different = ✗.",
  )
  .argument("[names...]", "extensions to check (default: all)")
  .option("--targets <csv>", "restrict to these targets (default: every target in the file)")
  .option("--targets-file <path>", "path to targets JSON", "./directus-deploy.targets.json")
  .option("--reference <ref>", "ref to compare deployed source tree against", "origin/develop")
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
      Object.values(r.cells).some((c) => c.sourceCommit && !c.matchesReference),
    );
    process.exit(drift ? 1 : 0);
  });

extensionsGroup
  .command("promote")
  .description(
    "Install a PRE-PUBLISHED artifact (gs://<artifact_bucket>/<name>/<sha>.tgz) on the target — byte-identical to what was validated on a lower env. Never builds; refuses when the artifact is missing (then: push --publish on test first). The sha is resolved from the CURRENT CHECKOUT, so check out the commit you mean (origin/develop → staging, origin/master → prod). Transport: --via ssh (default) or --via control (no SSH; through the target's control function). This is THE way anything reaches staging/prod: test is the only door for new bytes, everything above replays the archive.",
  )
  .argument("[names...]", "extensions to promote (default: --all)")
  .requiredOption("--target <env>", "target env name from the targets file (e.g. prod)")
  .option("--targets-file <path>", "path to targets JSON", "./directus-deploy.targets.json")
  .option("--repo-root <path>", "repo root (default: cwd)", process.cwd())
  .option("--all", "promote every extension under ./extensions")
  .option("--source-commit <sha>", "override the resolved short-sha (promote a specific historical artifact)")
  .option(
    "--via <transport>",
    "ssh (default): rsync/ssh directly to the VM. control: deploy through the target's control_url function — for callers without SSH egress (agent sandboxes)",
    "ssh",
  )
  .action(async (names: string[], opts: {
    target: string;
    targetsFile: string;
    repoRoot: string;
    all?: boolean;
    sourceCommit?: string;
    via: string;
  }) => {
    if (!["ssh", "control"].includes(opts.via)) {
      process.stderr.write(`unknown --via '${opts.via}' (ssh | control)\n`);
      process.exit(2);
    }
    const { promoteExtension, shaMatch } = await import("./extensions.js");
    let list = names;
    if ((!list || list.length === 0) && opts.all) {
      const { readdir } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const entries = await readdir(join(opts.repoRoot, "extensions"));
      list = entries.filter((e) => existsSync(join(opts.repoRoot, "extensions", e, "package.json"))).sort();
    }
    if (!list || list.length === 0) {
      process.stderr.write("no extensions to promote. Pass names or --all.\n");
      process.exit(2);
    }
    if (opts.sourceCommit && list.length !== 1) {
      process.stderr.write("--source-commit only makes sense with a single extension.\n");
      process.exit(2);
    }
    let anyFailed = false;
    for (const name of list) {
      try {
        process.stdout.write(`==> promote ${name} → ${opts.target}\n`);
        const r = await promoteExtension({
          extensionName: name,
          target: opts.target,
          targetsFile: opts.targetsFile,
          repoRoot: opts.repoRoot,
          sourceCommit: opts.sourceCommit,
          via: opts.via as "ssh" | "control",
        });
        const verify = r.verifiedCommit
          ? shaMatch(r.verifiedCommit, r.sourceCommit)
            ? "✓ verified"
            : `✗ /_meta reports ${r.verifiedCommit.slice(0, 8)}, expected ${r.sourceCommit.slice(0, 8)}`
          : "⚠ /_meta not readable — verify manually";
        process.stdout.write(
          `    artifact=${r.artifactUri} transport=${r.transportDurationMs}ms commit=${r.sourceCommit.slice(0, 8)} ${verify}\n`,
        );
        if (r.verifiedCommit && !shaMatch(r.verifiedCommit, r.sourceCommit)) anyFailed = true;
      } catch (e) {
        anyFailed = true;
        process.stderr.write(`    FAILED: ${(e as Error).message}\n`);
      }
    }
    process.exit(anyFailed ? 1 : 0);
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`directus-deploy: ${(e as Error).message}\n`);
  process.exit(2);
});
