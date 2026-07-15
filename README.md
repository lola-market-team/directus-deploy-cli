# lola-deploy

First-class Directus deployment tool. Reconciles code + config from git to any Directus environment — per-entity, non-atomic. Replaces the `directus-sync` + `register-table.mjs` + `ds push` sprawl that made every deploy of the LOLA Market backend a firefight.

## Why

`directus-sync push` applies the whole schema atomically via `/schema/apply`. One edge case ("field already exists", "relationship already associated", dangling meta.group ref, adopted-but-unregistered raw-SQL column) blocks every other change. In a repo with many contributors, multiple environments (test / staging / prod), and raw-SQL adopted tables, that atomic model is a firefight generator.

`lola-deploy` iterates each entity independently: `GET → POST | PATCH | SKIP`, one entity fails, the other 900 still apply. Per-entity report tells you exactly what changed and why the skips/failures happened.

## Install

```
npm install -g @lola/deploy
```

Or run without installing:

```
npx @lola/deploy@latest plan --url=... --token=...
```

## Usage

```
# Dry-run: show what would change against test, no writes
DIRECTUS_URL=https://test.lola.market DIRECTUS_TOKEN=... \
  lola-deploy plan

# Apply: reconcile the env
DIRECTUS_URL=https://test.lola.market DIRECTUS_TOKEN=... \
  lola-deploy apply

# Machine-readable JSON output (for CI reports)
lola-deploy plan --json

# Restrict to a subset
lola-deploy apply --entities=collections,fields --only-collections=listings,rentals
```

Points at `./directus_config/snapshot/` and `./migrations/register/` by default. Override with `--snapshot-dir` / `--register-dir`.

## Milestones

- **M1 (this release)** — collections, fields, relations. String-keyed, no id resolution needed. Three-tier collection model (managed / adopted / external).
- M2 — permissions, policies, roles. Composite-key resolution.
- M3 — flows, operations. Two-pass for `resolve` / `reject` references.
- M4 — migrations + register-table.mjs + extensions.
- M5 — wire into CI, retire `directus-sync`.
- M6 — manifest generator, retire `directus_config/snapshot/`.

## Design principles

1. **Non-atomic.** One drift never blocks 900 clean entities.
2. **Idempotent.** `apply` twice in a row: second run reports 0 changes.
3. **Multi-writer safe.** Adopted-but-unregistered raw-SQL columns are detected and skipped, not silently promoted into Directus-managed state.
4. **Local-first.** The same command runs against test in seconds on a laptop, no CI dependency.
5. **Observable.** JSON report is the source of truth for CI. Human-readable output is a formatter over the same data.

## License

Private, LOLA Market team internal.
