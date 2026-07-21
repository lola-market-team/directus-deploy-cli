#!/usr/bin/env node
// MCP server wrapping directus-deploy's reconciler graph. Speaks the Model
// Context Protocol on stdio so any MCP-aware Claude client (Chrome
// extension, Code CLI, Desktop, Claude in Cursor, …) can call plan/apply/
// verify as structured tools instead of shelling out.
//
// Usage in a Claude .mcp.json:
//   {
//     "mcpServers": {
//       "directus-deploy": {
//         "command": "node",
//         "args": ["<abs-path>/node_modules/directus-deploy-cli/dist/mcp-server.js"],
//         "env": { "DIRECTUS_URL": "...", "DIRECTUS_TOKEN": "..." }
//       }
//     }
//   }
//
// Tools exposed:
//   - directus_plan(target, entities?, only_collections?, snapshot_dir?, config_dir?,
//     register_dir?, migrations_dir?, seed_dir?) — dry-run report.
//   - directus_apply(...same shape...) — reconcile.
//   - directus_verify(...same shape...) — drift check; error result when drift found.
//
// Read-only inspection tools (never write to any target):
//   - directus_overview(repo_root?, targets_file?, targets?, from?, to?) — the full
//     deployment matrix: every target vs its git ref + the promotion queue.
//   - directus_migrations_status(target | url+token, ...) — applied vs pending SQL.
//   - directus_extensions_status(target, ...) — deployed sourceCommit per extension.
//   - directus_extensions_diff(reference?, targets?, ...) — deployed source tree vs ref.
//
// The targets-file tools resolve admin tokens by convention
// (DIRECTUS_<TARGET>_TOKEN, or the target's token_env) — pass those through the
// MCP server's env block. Each tool returns its JSON report.

// Auto-load .env from cwd (same convenience as the CLI): MCP clients often
// launch the server with a minimal env block, and the backend repo's .env
// already holds the DIRECTUS_<TARGET>_TOKEN vars. Never overrides real env.
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createDirectusClient } from "./http.js";
import { run } from "./runner.js";
import type { ApplyOptions, EntityKind, RunReport } from "./types.js";

const ALL_ENTITIES: EntityKind[] = [
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
];

const COMMON_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    url: {
      type: "string",
      description: "Directus base URL (defaults to $DIRECTUS_URL).",
    },
    token: {
      type: "string",
      description: "Directus admin token (defaults to $DIRECTUS_TOKEN).",
    },
    target: {
      type: "string",
      description: "Friendly label for the run report (defaults to URL hostname).",
    },
    entities: {
      type: "array",
      items: { type: "string", enum: ALL_ENTITIES },
      description: `Subset of ${ALL_ENTITIES.join(", ")} to reconcile. Defaults to all.`,
    },
    only_collections: {
      type: "array",
      items: { type: "string" },
      description: "Restrict the run to these collection names.",
    },
    snapshot_dir: {
      type: "string",
      description: "Absolute path to directus_config/snapshot/",
    },
    config_dir: {
      type: "string",
      description: "Absolute path to directus_config/collections/",
    },
    register_dir: {
      type: "string",
      description: "Absolute path to migrations/register/",
    },
    migrations_dir: {
      type: "string",
      description: "Absolute path to migrations/",
    },
    seed_dir: {
      type: "string",
      description: "Absolute path to directus_config/seed/",
    },
  },
  required: [],
};

interface CommonArgs {
  url?: string;
  token?: string;
  target?: string;
  entities?: string[];
  only_collections?: string[];
  snapshot_dir?: string;
  config_dir?: string;
  register_dir?: string;
  migrations_dir?: string;
  seed_dir?: string;
}

function requireEnv(arg: string | undefined, envVar: string, flag: string): string {
  const v = arg ?? process.env[envVar];
  if (!v) throw new Error(`missing ${flag} argument or $${envVar}`);
  return v;
}

function toDefaultDir(cwd: string, name: string): string {
  // Node's Path module is fine here — but avoid adding another import: the
  // Directus paths are usually absolute in caller-provided args anyway.
  return `${cwd.replace(/\/+$/, "")}/${name}`;
}

async function runReport(
  args: CommonArgs,
  opts: ApplyOptions,
): Promise<RunReport> {
  const url = requireEnv(args.url, "DIRECTUS_URL", "url");
  const token = requireEnv(args.token, "DIRECTUS_TOKEN", "token");
  const target = args.target ?? new URL(url).hostname;
  const entities = new Set(
    (args.entities ?? ALL_ENTITIES) as EntityKind[],
  );
  const cwd = process.cwd();
  const client = createDirectusClient({ baseUrl: url, token });
  return run({
    target,
    paths: {
      snapshotDir: args.snapshot_dir ?? toDefaultDir(cwd, "directus_config/snapshot"),
      configDir: args.config_dir ?? toDefaultDir(cwd, "directus_config/collections"),
      registerDir: args.register_dir ?? toDefaultDir(cwd, "migrations/register"),
    },
    migrationsDir: args.migrations_dir ?? toDefaultDir(cwd, "migrations"),
    seedDir: args.seed_dir ?? toDefaultDir(cwd, "directus_config/seed"),
    client,
    opts: {
      dryRun: opts.dryRun,
      onlyCollections: args.only_collections?.length
        ? new Set(args.only_collections)
        : undefined,
    },
    entities,
  });
}

async function handlePlan(args: CommonArgs): Promise<RunReport> {
  return runReport(args, { dryRun: true });
}

async function handleApply(args: CommonArgs): Promise<RunReport> {
  return runReport(args, { dryRun: false });
}

async function handleVerify(args: CommonArgs): Promise<{
  report: RunReport;
  drift: number;
}> {
  const report = await runReport(args, { dryRun: true });
  const drift = report.counts.created + report.counts.updated;
  return { report, drift };
}

// -------------------- read-only inspection tools --------------------

const DEFAULT_TARGETS_FILE = "./directus-deploy.targets.json";

interface RepoArgs {
  repo_root?: string;
  targets_file?: string;
}

function repoRoot(args: RepoArgs): string {
  return args.repo_root ?? process.cwd();
}

function targetsFile(args: RepoArgs): string {
  if (args.targets_file) return args.targets_file;
  if (args.repo_root) return toDefaultDir(args.repo_root, "directus-deploy.targets.json");
  return DEFAULT_TARGETS_FILE;
}

// Resolve {url, token} for a named target from the targets file, using the
// same convention as the CLI: token_env field, else DIRECTUS_<UPPER>_TOKEN.
async function resolveTargetConnection(
  name: string,
  file: string,
): Promise<{ url: string; token: string }> {
  const { loadTargets } = await import("./extensions.js");
  const cfg = await loadTargets(file);
  const t = cfg.targets[name];
  if (!t) {
    throw new Error(`unknown target '${name}' — known: ${Object.keys(cfg.targets).join(", ") || "(none)"}`);
  }
  const tokenEnv = t.token_env ?? `DIRECTUS_${name.toUpperCase()}_TOKEN`;
  const token = process.env[tokenEnv];
  if (!token) throw new Error(`target '${name}': $${tokenEnv} is not set in the MCP server env`);
  return { url: t.base_url, token };
}

interface OverviewArgs extends RepoArgs {
  targets?: string[];
  from?: string;
  to?: string;
}

async function handleOverview(args: OverviewArgs) {
  const { runOverview } = await import("./overview.js");
  return runOverview({
    targetsFile: targetsFile(args),
    repoRoot: repoRoot(args),
    targets: args.targets,
    from: args.from,
    to: args.to,
  });
}

interface MigrationsStatusArgs extends RepoArgs {
  target?: string;
  url?: string;
  token?: string;
  migrations_dir?: string;
  extensions_dir?: string;
}

async function handleMigrationsStatus(args: MigrationsStatusArgs) {
  let url: string;
  let token: string;
  if (args.target) {
    ({ url, token } = await resolveTargetConnection(args.target, targetsFile(args)));
  } else {
    url = requireEnv(args.url, "DIRECTUS_URL", "url");
    token = requireEnv(args.token, "DIRECTUS_TOKEN", "token");
  }
  const root = repoRoot(args);
  const client = createDirectusClient({ baseUrl: url, token });
  const { reconcileMigrations } = await import("./reconcilers/migrations.js");
  const results = await reconcileMigrations({
    migrationsDir: args.migrations_dir ?? toDefaultDir(root, "migrations"),
    extensionsDir: args.extensions_dir ?? toDefaultDir(root, "extensions"),
    includeExtensions: true,
    client,
    opts: { dryRun: true },
  });
  if (results.length === 1 && results[0]?.label === "migrations") {
    return { target: args.target ?? url, unreachable: true, reason: results[0].reason ?? "target unreachable" };
  }
  const applied: string[] = [];
  const pending: string[] = [];
  const mutated: Array<{ file: string; reason: string }> = [];
  for (const r of results) {
    const file = r.label.replace(/^migrations\//, "");
    if (r.action === "unchanged") applied.push(file);
    else if (r.action === "created") pending.push(file);
    else if (r.action === "failed") mutated.push({ file, reason: r.reason ?? "unknown" });
  }
  return { target: args.target ?? url, applied, pending, mutated };
}

interface ExtensionsStatusArgs extends RepoArgs {
  target: string;
  extensions?: string[];
}

async function handleExtensionsStatus(args: ExtensionsStatusArgs) {
  if (!args.target) throw new Error("missing required argument: target");
  const { statusExtensions } = await import("./extensions.js");
  return statusExtensions({
    target: args.target,
    targetsFile: targetsFile(args),
    extensions: args.extensions?.length ? args.extensions : undefined,
    repoRoot: repoRoot(args),
  });
}

interface ExtensionsDiffArgs extends RepoArgs {
  reference?: string;
  targets?: string[];
  extensions?: string[];
}

async function handleExtensionsDiff(args: ExtensionsDiffArgs) {
  const { diffExtensions } = await import("./extensions.js");
  return diffExtensions({
    targetsFile: targetsFile(args),
    reference: args.reference ?? "origin/develop",
    repoRoot: repoRoot(args),
    extensions: args.extensions?.length ? args.extensions : undefined,
    targets: args.targets?.length ? args.targets : undefined,
  });
}

async function main() {
  const server = new Server(
    { name: "directus-deploy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "directus_plan",
        description:
          "Dry-run against a Directus target: report what would change, no writes. Returns the full JSON report.",
        inputSchema: COMMON_INPUT_SCHEMA,
      },
      {
        name: "directus_apply",
        description:
          "Reconcile the target env to match directus_config/. Per-entity, non-atomic — a single failure never aborts the run. Returns the full JSON report.",
        inputSchema: COMMON_INPUT_SCHEMA,
      },
      {
        name: "directus_verify",
        description:
          "Post-apply drift check: dry-run then fail if any entity would be created or updated. Returns { report, drift } — drift > 0 means the target has diverged from git.",
        inputSchema: COMMON_INPUT_SCHEMA,
      },
      {
        name: "directus_overview",
        description:
          "READ-ONLY deployment matrix: every target compared against the git ref it deploys from (targets file `ref` field) across migrations/extensions/config/seeds, plus the promotion queue between refs (what's on develop but not master). The single best first call to understand deployment state. Requires DIRECTUS_<TARGET>_TOKEN env vars for the config/seed checks.",
        inputSchema: {
          type: "object" as const,
          properties: {
            repo_root: { type: "string", description: "Backend repo root (default: cwd). Must be a git checkout with the canonical layout." },
            targets_file: { type: "string", description: "Path to targets JSON (default: <repo_root>/directus-deploy.targets.json)." },
            targets: { type: "array", items: { type: "string" }, description: "Restrict to these targets (default: all in the file)." },
            from: { type: "string", description: "Promotion queue source ref (default: inferred from target refs)." },
            to: { type: "string", description: "Promotion queue destination ref (default: inferred)." },
          },
          required: [],
        },
      },
      {
        name: "directus_migrations_status",
        description:
          "READ-ONLY: which migrations/*.sql are applied on the target vs pending vs mutated. Pass `target` (targets-file name, token from $DIRECTUS_<TARGET>_TOKEN) or url+token.",
        inputSchema: {
          type: "object" as const,
          properties: {
            target: { type: "string", description: "Target name from the targets file (e.g. 'test', 'prod')." },
            url: { type: "string", description: "Directus base URL (alternative to target)." },
            token: { type: "string", description: "Admin token (alternative to target)." },
            repo_root: { type: "string", description: "Backend repo root (default: cwd)." },
            targets_file: { type: "string", description: "Path to targets JSON." },
            migrations_dir: { type: "string", description: "Path to migrations/ (default: <repo_root>/migrations)." },
            extensions_dir: { type: "string", description: "Root scanned for <name>/migrations/*.sql (default: <repo_root>/extensions)." },
          },
          required: [],
        },
      },
      {
        name: "directus_extensions_status",
        description:
          "READ-ONLY: the deployed sourceCommit + buildTime per extension on a target (from each extension's /_meta endpoint). No token needed.",
        inputSchema: {
          type: "object" as const,
          properties: {
            target: { type: "string", description: "Target name from the targets file." },
            extensions: { type: "array", items: { type: "string" }, description: "Restrict to these extensions (default: all under <repo_root>/extensions)." },
            repo_root: { type: "string", description: "Backend repo root (default: cwd)." },
            targets_file: { type: "string", description: "Path to targets JSON." },
          },
          required: ["target"],
        },
      },
      {
        name: "directus_extensions_diff",
        description:
          "READ-ONLY cross-env matrix: compares each extension's deployed source tree hash against a git ref (default origin/develop). Immune to squash-merge SHA orphaning. No token needed.",
        inputSchema: {
          type: "object" as const,
          properties: {
            reference: { type: "string", description: "Git ref to compare against (default: origin/develop)." },
            targets: { type: "array", items: { type: "string" }, description: "Restrict to these targets (default: all)." },
            extensions: { type: "array", items: { type: "string" }, description: "Restrict to these extensions (default: all)." },
            repo_root: { type: "string", description: "Backend repo root (default: cwd)." },
            targets_file: { type: "string", description: "Path to targets JSON." },
          },
          required: [],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as CommonArgs;
    try {
      let payload: unknown;
      switch (req.params.name) {
        case "directus_plan":
          payload = await handlePlan(args);
          break;
        case "directus_apply":
          payload = await handleApply(args);
          break;
        case "directus_verify":
          payload = await handleVerify(args);
          break;
        case "directus_overview":
          payload = await handleOverview(req.params.arguments as OverviewArgs ?? {});
          break;
        case "directus_migrations_status":
          payload = await handleMigrationsStatus(req.params.arguments as MigrationsStatusArgs ?? {});
          break;
        case "directus_extensions_status":
          payload = await handleExtensionsStatus(req.params.arguments as unknown as ExtensionsStatusArgs);
          break;
        case "directus_extensions_diff":
          payload = await handleExtensionsDiff(req.params.arguments as ExtensionsDiffArgs ?? {});
          break;
        default:
          throw new Error(`unknown tool: ${req.params.name}`);
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(payload, null, 2) },
        ],
      };
    } catch (e) {
      const msg = (e as Error).message;
      return {
        isError: true,
        content: [{ type: "text", text: msg }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`directus-deploy MCP: fatal ${(e as Error).message}\n`);
  process.exit(1);
});
