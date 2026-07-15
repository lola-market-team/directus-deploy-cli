// Load the snapshot files that describe the desired state. Reads the same
// on-disk shape directus-sync-style repo uses under directus_config/, so we
// can drop this tool into the existing repo without a migration.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Snapshot {
  // Schema (one file per entity under snapshot/)
  collections: Record<string, unknown>[];
  fieldsByCollection: Map<string, Record<string, unknown>[]>;
  relationsByCollection: Map<string, Record<string, unknown>[]>;
  // Auto-id entities (single array-of-objects file under collections/)
  policies: Record<string, unknown>[];
  roles: Record<string, unknown>[];
  permissions: Record<string, unknown>[];
  flows: Record<string, unknown>[];
  operations: Record<string, unknown>[];
  // Raw-SQL adoption
  registerManifests: Set<string>;
}

async function readJsonDir(dir: string): Promise<Record<string, unknown>[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries.filter((f) => f.endsWith(".json")).sort();
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    const text = await readFile(join(dir, f), "utf8");
    out.push(JSON.parse(text));
  }
  return out;
}

async function readCollectionSubdirs(dir: string): Promise<Map<string, Record<string, unknown>[]>> {
  const map = new Map<string, Record<string, unknown>[]>();
  let entries: string[];
  try {
    entries = await readdir(dir, { withFileTypes: false });
  } catch {
    return map;
  }
  for (const name of entries.sort()) {
    const rows = await readJsonDir(join(dir, name));
    if (rows.length) map.set(name, rows);
  }
  return map;
}

async function readJsonArray(path: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

async function readRegisterManifests(dir: string): Promise<Set<string>> {
  const set = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return set;
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    try {
      const j = JSON.parse(await readFile(join(dir, f), "utf8")) as { table?: string };
      if (j.table) set.add(j.table);
    } catch {
      // Ignore malformed manifests here — the caller reports them separately.
    }
  }
  return set;
}

export interface SnapshotPaths {
  snapshotDir: string;
  configDir: string;
  registerDir: string;
}

export async function loadSnapshot(paths: SnapshotPaths): Promise<Snapshot> {
  return {
    collections: await readJsonDir(join(paths.snapshotDir, "collections")),
    fieldsByCollection: await readCollectionSubdirs(join(paths.snapshotDir, "fields")),
    relationsByCollection: await readCollectionSubdirs(join(paths.snapshotDir, "relations")),
    policies: await readJsonArray(join(paths.configDir, "policies.json")),
    roles: await readJsonArray(join(paths.configDir, "roles.json")),
    permissions: await readJsonArray(join(paths.configDir, "permissions.json")),
    flows: await readJsonArray(join(paths.configDir, "flows.json")),
    operations: await readJsonArray(join(paths.configDir, "operations.json")),
    registerManifests: await readRegisterManifests(paths.registerDir),
  };
}
