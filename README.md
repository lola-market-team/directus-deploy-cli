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

## Overview

One matrix over every target: each environment compared against the git ref it deploys from, plus a promotion-queue column showing what sits on develop but hasn't reached master yet.

```
$ directus-deploy overview

              test                staging             prod                develop → master
              vs origin/develop   vs origin/develop   vs origin/master    promotion queue

  migrations  ✓ 86 applied        ✓ 86 applied        ✓ 85 applied        1 new
  extensions  ✓ 21/21 match       ✗ 1 behind          ✗ 1 behind          3 changed
  config      ✓ in sync           ✗ 10 changes        ✓ in sync           20 file(s)
  seeds       ✓ in sync           ✗ 31 changes        ✓ in sync           3 file(s)
```

Each target declares its branch in the targets file (`"ref": "origin/develop"`); the artifacts at that ref are materialized via `git archive` and dry-run against the env, so the comparison is branch-vs-env, not worktree-vs-env. A target without `ref` falls back to the working tree. The promotion pair is inferred from the refs (the `build_forbidden` target pins the destination) or passed with `--from`/`--to`; it is pure git and never affects the exit code.

Exit codes: `0` in sync, `1` drift, `2` a check could not run. `--json` emits the full report (untruncated detail lists) for dashboards or Slack bots.

## MCP server

Ships an MCP server exposing the reconciler as structured tools:

- `directus_plan` / `directus_apply` / `directus_verify` — the write path (plan is a dry-run).
- `directus_overview` — read-only deployment matrix (targets vs their refs + promotion queue); the best first call for an agent assessing deployment state.
- `directus_migrations_status`, `directus_extensions_status`, `directus_extensions_diff` — read-only per-dimension checks.

The server auto-loads `.env` from its cwd, so pointing `cwd` at the backend repo gives it the `DIRECTUS_<TARGET>_TOKEN` vars. Register in your Claude client's `.mcp.json`:

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
