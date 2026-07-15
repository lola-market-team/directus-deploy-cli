#!/usr/bin/env node
// MCP server wrapping lola-deploy's reconciler graph. Speaks the Model
// Context Protocol on stdio so any MCP-aware Claude client (Chrome
// extension, Code CLI, Desktop, Claude in Cursor, …) can call plan/apply/
// verify as structured tools instead of shelling out.
//
// Usage in a Claude .mcp.json:
//   {
//     "mcpServers": {
//       "lola-deploy": {
//         "command": "node",
//         "args": ["<abs-path>/node_modules/@lola/deploy/dist/mcp-server.js"],
//         "env": { "DIRECTUS_URL": "...", "DIRECTUS_TOKEN": "..." }
//       }
//     }
//   }
//
// Tools exposed:
//   - lola.plan(target, entities?, only_collections?, snapshot_dir?, config_dir?,
//     register_dir?, migrations_dir?, seed_dir?) — dry-run report.
//   - lola.apply(...same shape...) — reconcile.
//   - lola.verify(...same shape...) — drift check; error result when drift found.
//
// Each tool returns the JSON report (see src/types.ts RunReport).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { createDirectusClient } from "./http.js";
import { run } from "./runner.js";
const ALL_ENTITIES = [
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
    type: "object",
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
function requireEnv(arg, envVar, flag) {
    const v = arg ?? process.env[envVar];
    if (!v)
        throw new Error(`missing ${flag} argument or $${envVar}`);
    return v;
}
function toDefaultDir(cwd, name) {
    // Node's Path module is fine here — but avoid adding another import: the
    // Directus paths are usually absolute in caller-provided args anyway.
    return `${cwd.replace(/\/+$/, "")}/${name}`;
}
async function runReport(args, opts) {
    const url = requireEnv(args.url, "DIRECTUS_URL", "url");
    const token = requireEnv(args.token, "DIRECTUS_TOKEN", "token");
    const target = args.target ?? new URL(url).hostname;
    const entities = new Set((args.entities ?? ALL_ENTITIES));
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
async function handlePlan(args) {
    return runReport(args, { dryRun: true });
}
async function handleApply(args) {
    return runReport(args, { dryRun: false });
}
async function handleVerify(args) {
    const report = await runReport(args, { dryRun: true });
    const drift = report.counts.created + report.counts.updated;
    return { report, drift };
}
async function main() {
    const server = new Server({ name: "lola-deploy", version: "0.1.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            {
                name: "lola_plan",
                description: "Dry-run against a Directus target: report what would change, no writes. Returns the full JSON report.",
                inputSchema: COMMON_INPUT_SCHEMA,
            },
            {
                name: "lola_apply",
                description: "Reconcile the target env to match directus_config/. Per-entity, non-atomic — a single failure never aborts the run. Returns the full JSON report.",
                inputSchema: COMMON_INPUT_SCHEMA,
            },
            {
                name: "lola_verify",
                description: "Post-apply drift check: dry-run then fail if any entity would be created or updated. Returns { report, drift } — drift > 0 means the target has diverged from git.",
                inputSchema: COMMON_INPUT_SCHEMA,
            },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const args = (req.params.arguments ?? {});
        try {
            let payload;
            switch (req.params.name) {
                case "lola_plan":
                    payload = await handlePlan(args);
                    break;
                case "lola_apply":
                    payload = await handleApply(args);
                    break;
                case "lola_verify":
                    payload = await handleVerify(args);
                    break;
                default:
                    throw new Error(`unknown tool: ${req.params.name}`);
            }
            return {
                content: [
                    { type: "text", text: JSON.stringify(payload, null, 2) },
                ],
            };
        }
        catch (e) {
            const msg = e.message;
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
    process.stderr.write(`lola-deploy MCP: fatal ${e.message}\n`);
    process.exit(1);
});
//# sourceMappingURL=mcp-server.js.map