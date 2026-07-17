import { loadSnapshot } from "./manifest.js";
import { reconcileCollections } from "./reconcilers/collections.js";
import { reconcileFields } from "./reconcilers/fields.js";
import { reconcileRelations } from "./reconcilers/relations.js";
import { reconcileRoles } from "./reconcilers/roles.js";
import { reconcilePolicies } from "./reconcilers/policies.js";
import { reconcilePermissions } from "./reconcilers/permissions.js";
import { reconcileFlowsPass1, reconcileFlowsPass2 } from "./reconcilers/flows.js";
import { reconcileOperationsPass1, reconcileOperationsPass2, } from "./reconcilers/operations.js";
import { reconcileMigrations } from "./reconcilers/migrations.js";
import { reconcileRegister } from "./reconcilers/register.js";
import { reconcileSeeds } from "./reconcilers/seeds.js";
import { buildIdentity } from "./identity.js";
export function summarize(results, target) {
    const counts = {
        created: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        failed: 0,
    };
    for (const r of results)
        counts[r.action] += 1;
    return { target, results, counts };
}
export async function run(input) {
    const snapshot = await loadSnapshot(input.paths);
    const results = [];
    // Migrations first — they may introduce raw-SQL tables and columns that
    // subsequent reconcilers reference. Idempotent (tracked per-file in
    // lola_deploy_migrations on the target).
    if (input.entities.has("migrations") && input.migrationsDir) {
        results.push(...(await reconcileMigrations({
            migrationsDir: input.migrationsDir,
            extensionsDir: input.extensionsDir,
            includeExtensions: input.includeExtensions,
            client: input.client,
            opts: input.opts,
        })));
        // Register manifests for raw-SQL adopted tables. Runs alongside migrations
        // because the two are conceptually paired: a migration creates the raw
        // table, its manifest teaches Directus about the columns. Piggy-backs on
        // the `migrations` entity kind so callers don't need to opt in twice.
        results.push(...(await reconcileRegister({
            registerDir: input.paths.registerDir,
            client: input.client,
            opts: input.opts,
        })));
    }
    // Order matters:
    //   collections → fields → relations   (schema, string keys)
    //   roles → policies → permissions     (auto-id, cross-refs by name)
    if (input.entities.has("collections")) {
        results.push(...(await reconcileCollections({
            collections: snapshot.collections,
            registerManifests: snapshot.registerManifests,
            client: input.client,
            opts: input.opts,
        })));
    }
    if (input.entities.has("fields")) {
        results.push(...(await reconcileFields({
            fieldsByCollection: snapshot.fieldsByCollection,
            registerManifests: snapshot.registerManifests,
            client: input.client,
            opts: input.opts,
        })));
    }
    if (input.entities.has("relations")) {
        results.push(...(await reconcileRelations({
            relationsByCollection: snapshot.relationsByCollection,
            client: input.client,
            opts: input.opts,
        })));
    }
    // Auto-id entities need an identity index built once per phase.
    const needsIdentity = input.entities.has("policies") ||
        input.entities.has("permissions") ||
        input.entities.has("roles") ||
        input.entities.has("flows") ||
        input.entities.has("operations");
    if (needsIdentity) {
        if (input.entities.has("roles")) {
            results.push(...(await reconcileRoles({
                roles: snapshot.roles,
                client: input.client,
                opts: input.opts,
            })));
        }
        const identity1 = await buildIdentity(input.client, snapshot.policies, snapshot.roles, snapshot.flows, snapshot.operations);
        if (input.entities.has("policies")) {
            results.push(...(await reconcilePolicies({
                policies: snapshot.policies,
                identity: identity1,
                client: input.client,
                opts: input.opts,
            })));
        }
        if (input.entities.has("permissions")) {
            // Re-fetch identity so policies just created are resolvable.
            const identity2 = await buildIdentity(input.client, snapshot.policies, snapshot.roles, snapshot.flows, snapshot.operations);
            results.push(...(await reconcilePermissions({
                permissions: snapshot.permissions,
                identity: identity2,
                client: input.client,
                opts: input.opts,
            })));
        }
        // Flows + operations: two-pass to break the mutual FK cycle.
        if (input.entities.has("flows") || input.entities.has("operations")) {
            const identityF = await buildIdentity(input.client, snapshot.policies, snapshot.roles, snapshot.flows, snapshot.operations);
            if (input.entities.has("flows")) {
                results.push(...(await reconcileFlowsPass1({
                    flows: snapshot.flows,
                    identity: identityF,
                    client: input.client,
                    opts: input.opts,
                })));
            }
            if (input.entities.has("operations")) {
                // Refresh identity so newly-created flow ids become resolvable.
                const identityO = await buildIdentity(input.client, snapshot.policies, snapshot.roles, snapshot.flows, snapshot.operations);
                results.push(...(await reconcileOperationsPass1({
                    operations: snapshot.operations,
                    identity: identityO,
                    client: input.client,
                    opts: input.opts,
                })));
                // Second pass on operations: resolve/reject refs.
                const identityO2 = await buildIdentity(input.client, snapshot.policies, snapshot.roles, snapshot.flows, snapshot.operations);
                results.push(...(await reconcileOperationsPass2({
                    operations: snapshot.operations,
                    identity: identityO2,
                    client: input.client,
                    opts: input.opts,
                })));
            }
            if (input.entities.has("flows")) {
                // Final pass on flows: link each flow's entry `operation` to its
                // freshly-reconciled server op id.
                const identityFinal = await buildIdentity(input.client, snapshot.policies, snapshot.roles, snapshot.flows, snapshot.operations);
                results.push(...(await reconcileFlowsPass2({
                    flows: snapshot.flows,
                    identity: identityFinal,
                    client: input.client,
                    opts: input.opts,
                })));
            }
        }
    }
    // Seed data — data-tables (messaging_templates, notification_types, …). Runs
    // last so any referenced collections/policies/flows exist first.
    if (input.entities.has("seeds") && input.seedDir) {
        results.push(...(await reconcileSeeds({
            seedDir: input.seedDir,
            client: input.client,
            opts: input.opts,
        })));
    }
    return summarize(results, input.target);
}
//# sourceMappingURL=runner.js.map