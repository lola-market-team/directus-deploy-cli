import type {
  ApplyOptions,
  DirectusClient,
  EntityKind,
  EntityResult,
  RunReport,
} from "./types.js";
import { loadSnapshot } from "./manifest.js";
import type { SnapshotPaths } from "./manifest.js";
import { reconcileCollections } from "./reconcilers/collections.js";
import { reconcileFields } from "./reconcilers/fields.js";
import { reconcileRelations } from "./reconcilers/relations.js";
import { reconcileRoles } from "./reconcilers/roles.js";
import { reconcilePolicies } from "./reconcilers/policies.js";
import { reconcilePermissions } from "./reconcilers/permissions.js";
import { buildIdentity } from "./identity.js";

export interface RunInput {
  target: string;
  paths: SnapshotPaths;
  client: DirectusClient;
  opts: ApplyOptions;
  entities: Set<EntityKind>;
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
  const snapshot = await loadSnapshot(input.paths);
  const results: EntityResult[] = [];

  // Order matters:
  //   collections → fields → relations   (schema, string keys)
  //   roles → policies → permissions     (auto-id, cross-refs by name)
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

  // Auto-id entities need an identity index built once, reused across kinds.
  const needsIdentity =
    input.entities.has("policies") ||
    input.entities.has("permissions") ||
    input.entities.has("roles");
  if (needsIdentity) {
    if (input.entities.has("roles")) {
      results.push(
        ...(await reconcileRoles({
          roles: snapshot.roles,
          client: input.client,
          opts: input.opts,
        })),
      );
    }
    const identity = await buildIdentity(input.client, snapshot.policies, snapshot.roles);
    if (input.entities.has("policies")) {
      results.push(
        ...(await reconcilePolicies({
          policies: snapshot.policies,
          identity,
          client: input.client,
          opts: input.opts,
        })),
      );
    }
    if (input.entities.has("permissions")) {
      // Re-fetch identity so policies just created in the prior step are
      // resolvable. Roles are usually stable, so we only refresh policies.
      const refreshed = await buildIdentity(input.client, snapshot.policies, snapshot.roles);
      results.push(
        ...(await reconcilePermissions({
          permissions: snapshot.permissions,
          identity: refreshed,
          client: input.client,
          opts: input.opts,
        })),
      );
    }
  }

  return summarize(results, input.target);
}
