import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Static snapshot integrity checks — port of scripts/lint-snapshot-refs.py
// from lola-market-backend, one-for-one. Runs in pre-push to catch drift
// classes that break `apply` silently:
//
//   A. meta.group refs in snapshot/collections/*.json must resolve
//   B. snapshot/fields/**/*.json foreign_key_table refs must resolve
//      (Directus system collections like directus_users are runtime-provided
//      and never appear in the snapshot — ignored.)
//   C. migrations/*.sql `-- line` comments must NOT contain ';'
//      (raw-query's SQL splitter naively splits on every ';'.)
//   D. migrations/register/<name>.json must be paired with
//      snapshot/collections/<name>.json AND a non-empty
//      snapshot/fields/<name>/ dir.
//   E. Every snapshot collection with a `schema` block (real table, not a UI
//      folder) must have a snapshot/fields/<name>/ dir.
//
// Motivating incidents documented in the Python original — see docstring.

export interface SnapshotLintInput {
  snapshotDir: string;      // …/directus_config/snapshot
  migrationsDir: string;    // …/migrations
  registerDir: string;      // …/migrations/register
  repoRoot?: string;        // for report path shortening (defaults to snapshotDir's parent-parent)
}

export interface LintOffender {
  file: string;
  message: string;
}

export interface SnapshotLintReport {
  collectionsScanned: number;
  offenders: LintOffender[];
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function listJson(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

function rel(root: string | undefined, path: string): string {
  return root ? relative(root, path) : path;
}

async function loadKnownCollections(collectionsDir: string): Promise<{
  names: Set<string>;
  bySchema: Map<string, string>; // name → source file path (for reporting)
  bySchemaOnly: Set<string>; // names of collections that carry a `schema` block (data collections)
}> {
  const names = new Set<string>();
  const bySchema = new Map<string, string>();
  const bySchemaOnly = new Set<string>();
  for (const f of await listJson(collectionsDir)) {
    const path = join(collectionsDir, f);
    const data = await readJson(path);
    if (!data) continue;
    const c = String((data as { collection?: unknown }).collection ?? "");
    if (c) {
      names.add(c);
      bySchema.set(c, path);
      if ((data as { schema?: unknown }).schema) bySchemaOnly.add(c);
    }
  }
  return { names, bySchema, bySchemaOnly };
}

async function checkGroupRefs(
  collectionsDir: string,
  known: Set<string>,
  root: string | undefined,
): Promise<LintOffender[]> {
  const offenders: LintOffender[] = [];
  for (const f of await listJson(collectionsDir)) {
    const path = join(collectionsDir, f);
    const data = await readJson(path);
    if (!data) continue;
    const meta = (data as { meta?: unknown }).meta as Record<string, unknown> | undefined;
    const group = meta ? String(meta.group ?? "") : "";
    if (group && !known.has(group)) {
      offenders.push({
        file: rel(root, path),
        message: `meta.group="${group}" — no such collection in snapshot`,
      });
    }
  }
  return offenders;
}

async function checkFieldFks(
  fieldsDir: string,
  known: Set<string>,
  root: string | undefined,
): Promise<LintOffender[]> {
  const offenders: LintOffender[] = [];
  for (const coll of await listSubdirs(fieldsDir)) {
    const collDir = join(fieldsDir, coll);
    for (const f of await listJson(collDir)) {
      const path = join(collDir, f);
      const data = await readJson(path);
      if (!data) continue;
      const schema = (data as { schema?: unknown }).schema as Record<string, unknown> | undefined;
      const fkTable = schema ? String(schema.foreign_key_table ?? "") : "";
      if (!fkTable) continue;
      // Directus system collections (directus_users, directus_files, …) are
      // runtime-provided; they never appear in the snapshot.
      if (fkTable.startsWith("directus_")) continue;
      if (!known.has(fkTable)) {
        offenders.push({
          file: rel(root, path),
          message: `FK → ${fkTable} — no such collection in snapshot`,
        });
      }
    }
  }
  return offenders;
}

async function checkDataCollectionsHaveFields(
  bySchema: Map<string, string>,
  bySchemaOnly: Set<string>,
  fieldsDir: string,
  root: string | undefined,
): Promise<LintOffender[]> {
  const offenders: LintOffender[] = [];
  for (const name of bySchemaOnly) {
    const collPath = bySchema.get(name);
    if (!collPath) continue;
    const collFieldsDir = join(fieldsDir, name);
    let hasField = false;
    if (existsSync(collFieldsDir)) {
      const files = await listJson(collFieldsDir);
      hasField = files.length > 0;
    }
    if (!hasField) {
      offenders.push({
        file: rel(root, collPath),
        message: `collection '${name}' has a schema block but no snapshot/fields/${name}/ dir — pull the schema (directus-deploy snapshot pull, or scripts/pull-collection-schema.py)`,
      });
    }
  }
  return offenders;
}

async function checkRegisterManifestPairing(
  registerDir: string,
  known: Set<string>,
  fieldsDir: string,
  root: string | undefined,
): Promise<LintOffender[]> {
  const offenders: LintOffender[] = [];
  for (const f of await listJson(registerDir)) {
    const path = join(registerDir, f);
    const data = await readJson(path);
    if (!data) {
      offenders.push({ file: rel(root, path), message: "unreadable" });
      continue;
    }
    const table = String((data as { table?: unknown }).table ?? "");
    if (!table) {
      offenders.push({ file: rel(root, path), message: "missing 'table' key" });
      continue;
    }
    if (!known.has(table)) {
      offenders.push({
        file: rel(root, path),
        message: `register manifest for '${table}' but no snapshot/collections/${table}.json`,
      });
      continue;
    }
    const collFieldsDir = join(fieldsDir, table);
    let hasField = false;
    if (existsSync(collFieldsDir)) {
      const files = await listJson(collFieldsDir);
      hasField = files.length > 0;
    }
    if (!hasField) {
      offenders.push({
        file: rel(root, path),
        message: `register manifest for '${table}' but snapshot/fields/${table}/ is empty or missing`,
      });
    }
  }
  return offenders;
}

// Every directory that can hold migrations: the repo-root migrations/ AND
// each extensions/<name>/migrations/. Both feed the same tracker (extension
// files under `ext/<name>/<file>` keys) and both are applied by the same
// reconciler, so a hazard in one is a hazard in the other.
//
// This check used to scan only the root dir. The gap was not theoretical: a
// `;` inside a `--` comment in extensions/rental-fsm/migrations/074 reached a
// live target, where the server-side splitter chopped the file mid-statement
// and the DROP CONSTRAINT never ran — while the apply reported success and the
// schema was silently unchanged.
async function migrationDirs(
  migrationsDir: string,
): Promise<string[]> {
  const dirs = [migrationsDir];
  // migrationsDir is <repo>/migrations, so extensions/ is its sibling.
  const extensionsRoot = join(dirname(migrationsDir), "extensions");
  const entries = await readdir(extensionsRoot, { withFileTypes: true }).catch(
    () => [] as Awaited<ReturnType<typeof readdir>> as never[],
  );
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = join(extensionsRoot, e.name, "migrations");
    const stat = await readdir(candidate).catch(() => null);
    if (stat) dirs.push(candidate);
  }
  return dirs;
}

async function checkMigrationCommentSemicolons(
  migrationsDir: string,
  root: string | undefined,
): Promise<LintOffender[]> {
  const offenders: LintOffender[] = [];
  const commentRe = /^\s*--.*;/;
  for (const dir of await migrationDirs(migrationsDir)) {
  const sqlFiles = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of sqlFiles) {
    const path = join(dir, f);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (commentRe.test(lines[i]!)) {
        offenders.push({
          file: `${rel(root, path)}:${i + 1}`,
          message: "'--' line contains ';' — raw-query's naive splitter will chop the file here",
        });
      }
    }
  }
  }
  return offenders;
}

export async function lintSnapshot(input: SnapshotLintInput): Promise<SnapshotLintReport> {
  const collectionsDir = join(input.snapshotDir, "collections");
  const fieldsDir = join(input.snapshotDir, "fields");
  const root = input.repoRoot;

  if (!existsSync(collectionsDir)) {
    return {
      collectionsScanned: 0,
      offenders: [
        { file: collectionsDir, message: "snapshot/collections not found" },
      ],
    };
  }

  const { names, bySchema, bySchemaOnly } = await loadKnownCollections(collectionsDir);

  const offenders = [
    ...(await checkGroupRefs(collectionsDir, names, root)),
    ...(await checkFieldFks(fieldsDir, names, root)),
    ...(await checkMigrationCommentSemicolons(input.migrationsDir, root)),
    ...(await checkRegisterManifestPairing(input.registerDir, names, fieldsDir, root)),
    ...(await checkDataCollectionsHaveFields(bySchema, bySchemaOnly, fieldsDir, root)),
  ];

  return { collectionsScanned: names.size, offenders };
}
