// Load the snapshot files that describe the desired state. M1 reads the same
// on-disk shape lola-market-backend already uses under directus_config/snapshot/,
// so we can drop this tool into the existing repo without a migration.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Snapshot {
  collections: Record<string, unknown>[];
  fieldsByCollection: Map<string, Record<string, unknown>[]>;
  relationsByCollection: Map<string, Record<string, unknown>[]>;
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

export async function loadSnapshot(
  snapshotDir: string,
  registerDir: string,
): Promise<Snapshot> {
  return {
    collections: await readJsonDir(join(snapshotDir, "collections")),
    fieldsByCollection: await readCollectionSubdirs(join(snapshotDir, "fields")),
    relationsByCollection: await readCollectionSubdirs(join(snapshotDir, "relations")),
    registerManifests: await readRegisterManifests(registerDir),
  };
}
