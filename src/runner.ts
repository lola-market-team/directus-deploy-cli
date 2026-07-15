import type {
  ApplyOptions,
  DirectusClient,
  EntityResult,
  RunReport,
} from "./types.js";
import { loadSnapshot } from "./manifest.js";
import { reconcileCollections } from "./reconcilers/collections.js";
import { reconcileFields } from "./reconcilers/fields.js";
import { reconcileRelations } from "./reconcilers/relations.js";

export interface RunInput {
  target: string;
  snapshotDir: string;
  registerDir: string;
  client: DirectusClient;
  opts: ApplyOptions;
  entities: Set<"collections" | "fields" | "relations">;
}

export function summarize(results: EntityResult[], target: string): RunReport {
  const counts: RunReport["counts"] = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  };
  for (const r of results) counts[r.action] += 1;
  return { target, results, counts };
}

export async function run(input: RunInput): Promise<RunReport> {
  const snapshot = await loadSnapshot(input.snapshotDir, input.registerDir);
  const results: EntityResult[] = [];

  // Dependency order: collections → fields → relations.
  if (input.entities.has("collections")) {
    results.push(
      ...(await reconcileCollections({
        collections: snapshot.collections,
        registerManifests: snapshot.registerManifests,
        client: input.client,
        opts: input.opts,
      })),
    );
  }
  if (input.entities.has("fields")) {
    results.push(
      ...(await reconcileFields({
        fieldsByCollection: snapshot.fieldsByCollection,
        registerManifests: snapshot.registerManifests,
        client: input.client,
        opts: input.opts,
      })),
    );
  }
  if (input.entities.has("relations")) {
    results.push(
      ...(await reconcileRelations({
        relationsByCollection: snapshot.relationsByCollection,
        client: input.client,
        opts: input.opts,
      })),
    );
  }
  return summarize(results, input.target);
}
