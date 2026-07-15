# directus-deploy-cli

Per-entity, non-atomic Directus deployment tool. Reconciles code + config from a git repository to any Directus environment. Handles collections, fields, relations, roles, policies, permissions, flows, operations, raw-SQL migrations, register manifests, and seed data.

## Why not the built-in schema apply?

Directus's `/schema/apply` is atomic — one edge case ("field already exists", "relationship already associated", dangling `meta.group` ref, adopted-but-unregistered raw-SQL column) blocks every other change. In a repo with many contributors, multiple environments, and raw-SQL adopted tables, that atomic model becomes a firefight generator.

`directus-deploy` iterates each entity independently: `GET → POST | PATCH | SKIP`. If one entity fails, the other 900 still apply. Per-entity report tells you exactly what changed and why the skips/failures happened.

## Install

```
npm install -g directus-deploy-cli
```

## Use

```
DIRECTUS_URL=https://your-directus DIRECTUS_TOKEN=... \
  directus-deploy verify \
    --snapshot-dir=./directus_config/snapshot \
    --config-dir=./directus_config/collections \
    --seed-dir=./directus_config/seed \
    --migrations-dir=./migrations \
    --register-dir=./migrations/register
```

Commands: `plan` (dry-run report), `apply` (reconcile), `verify` (drift check; exits non-zero if apply would change anything).

## MCP server

Ships an MCP server exposing `directus_plan` / `directus_apply` / `directus_verify` as structured tools. Register in your Claude client's `.mcp.json`:

```json
{
  "mcpServers": {
    "directus-deploy": {
      "command": "node",
      "args": ["<abs-path>/node_modules/directus-deploy-cli/dist/mcp-server.js"],
      "env": { "DIRECTUS_URL": "...", "DIRECTUS_TOKEN": "..." }
    }
  }
}
```

## On-disk layout

Compatible with the `directus-sync`-style tree:

```
directus_config/
  snapshot/{collections,fields,relations}/*.json
  collections/{roles,policies,permissions,flows,operations}.json
  seed/*.json
migrations/*.sql
migrations/register/*.json
```

## License

MIT
