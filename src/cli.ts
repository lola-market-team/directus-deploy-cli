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
    json: Boolean(flags.json),
  };
}

async function execute(dryRun: boolean, flags: CommonFlags): Promise<number> {
  const common = readCommon(flags);
  const client = createDirectusClient({ baseUrl: common.url, token: common.token });
  const opts: ApplyOptions = { dryRun, onlyCollections: common.onlyCollections };
  const report = await run({
    target: common.target,
    paths: {
      snapshotDir: common.snapshotDir,
      configDir: common.configDir,
      registerDir: common.registerDir,
    },
    client,
    opts,
    entities: common.entities,
  });
  if (common.json) {
    process.stdout.write(formatJson(report) + "\n");
  } else {
    process.stdout.write(formatHuman(report) + "\n");
  }
  return report.counts.failed > 0 ? 1 : 0;
}

const program = new Command();
program
  .name("lola-deploy")
  .description(
    "Reconcile a Directus environment to the state described in directus_config/snapshot/. Per-entity, non-atomic.",
  )
  .version("0.1.0");

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
    .option("--json", "emit JSON report instead of human-readable");
}

attachCommon(program.command("plan"))
  .description("Dry-run: report what would change without writing.")
  .action(async (_, cmd) => {
    process.exit(await execute(true, cmd.optsWithGlobals()));
  });

attachCommon(program.command("apply"))
  .description("Apply the desired state to the target env.")
  .action(async (_, cmd) => {
    process.exit(await execute(false, cmd.optsWithGlobals()));
  });

program.parseAsync(process.argv).catch((e) => {
  process.stderr.write(`lola-deploy: ${(e as Error).message}\n`);
  process.exit(2);
});
