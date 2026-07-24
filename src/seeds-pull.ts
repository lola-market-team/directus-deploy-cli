// seeds pull (#37) — regenerate a Tractr-style seed file from a live target.
// The seed-side sibling of `snapshot pull`: fetches the collection restricted
// to the seed-managed columns and rewrites directus_config/seed/<collection>.json
// deterministically, preserving an existing file's `meta` block.
//
// Ordering contract: parents before children (topo over the self-referencing
// parent field, when one is present in the pulled columns) so a fresh env can
// insert in file order without tripping the FK; PK-ascending within a level
// for stable git diffs.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DirectusClient } from "./types.js";
import { resolvePrimaryKey } from "./reconcilers/seeds.js";

export interface SeedsPullInput {
  client: DirectusClient;
  seedDir: string;
  collection: string;
  fields?: string[]; // required for a first pull; defaults to the existing file's columns
  filter?: string; // raw Directus filter JSON, passed through
  parentField?: string; // default: auto-detect "parent_id" among the columns
  insertOrder?: number; // meta.insert_order for a brand-new file (default 50)
}

export interface SeedsPullResult {
  path: string;
  rows: number;
  fields: string[];
}

interface SeedFileShape {
  collection: string;
  meta: Record<string, unknown>;
  data: Array<Record<string, unknown>>;
}

async function readExisting(path: string): Promise<SeedFileShape | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as SeedFileShape;
  } catch {
    return null;
  }
}

function deriveFields(existing: SeedFileShape): string[] {
  const keys = new Set<string>();
  for (const row of existing.data ?? []) {
    for (const k of Object.keys(row)) if (k !== "_sync_id") keys.add(k);
  }
  return [...keys];
}

function topoSort(
  rows: Array<Record<string, unknown>>,
  pk: string,
  parentField: string | null,
): Array<Record<string, unknown>> {
  const byPkAsc = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const av = a[pk] as number | string;
    const bv = b[pk] as number | string;
    return av < bv ? -1 : av > bv ? 1 : 0;
  };
  if (!parentField) return [...rows].sort(byPkAsc);
  const byId = new Map(rows.map((r) => [String(r[pk]), r]));
  const level = new Map<string, number>();
  const levelOf = (r: Record<string, unknown>): number => {
    const id = String(r[pk]);
    const hit = level.get(id);
    if (hit !== undefined) return hit;
    level.set(id, 0); // cycle guard: a parent loop degrades to level 0
    const parent = r[parentField];
    const parentRow = parent === null || parent === undefined ? undefined : byId.get(String(parent));
    const l = parentRow ? levelOf(parentRow) + 1 : 0;
    level.set(id, l);
    return l;
  };
  return [...rows].sort((a, b) => levelOf(a) - levelOf(b) || byPkAsc(a, b));
}

export async function pullSeed(input: SeedsPullInput): Promise<SeedsPullResult> {
  const path = join(input.seedDir, `${input.collection}.json`);
  const existing = await readExisting(path);

  const pk = await resolvePrimaryKey(input.client, input.collection, new Map());
  let fields = input.fields ?? (existing ? deriveFields(existing) : []);
  if (fields.length === 0) {
    throw new Error(
      `seeds pull ${input.collection}: no --fields given and no existing seed file to derive them from`,
    );
  }
  if (!fields.includes(pk)) fields = [pk, ...fields];

  const params = new URLSearchParams({ fields: fields.join(","), limit: "-1" });
  if (input.filter) params.set("filter", input.filter);
  const raw = await input.client.get(`/items/${input.collection}?${params.toString()}`);
  const rows = (Array.isArray(raw) ? raw : ((raw as { data?: unknown } | null)?.data ?? [])) as Array<
    Record<string, unknown>
  >;
  if (!Array.isArray(rows)) throw new Error(`seeds pull ${input.collection}: unexpected response shape`);

  const seen = new Set<string>();
  for (const r of rows) {
    const id = String(r[pk]);
    if (seen.has(id)) {
      // preserve_ids seeds never converge with duplicate ids — hard error,
      // same contract as the LOLA fsm:drift §8 gate.
      throw new Error(`seeds pull ${input.collection}: duplicate ${pk}=${id} on the target`);
    }
    seen.add(id);
  }

  const parentField =
    input.parentField ?? (fields.includes("parent_id") ? "parent_id" : null);
  const ordered = topoSort(rows, pk, parentField).map((r) => {
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f] = r[f] ?? null;
    return out;
  });

  const meta = existing?.meta ?? {
    insert_order: input.insertOrder ?? 50,
    preserve_ids: true,
    create: true,
    update: true,
    delete: false,
  };
  const body: SeedFileShape = { collection: input.collection, meta, data: ordered };
  await writeFile(path, JSON.stringify(body, null, 2) + "\n", "utf8");
  return { path, rows: ordered.length, fields };
}
