import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
import type { IdentityIndex } from "../identity.js";
import { resolveOpSyncIdToServerId } from "../identity.js";

// Flows are identity-by-`name`. UUID PK. Cross-refs:
//   - `operation`: entry operation's _syncId (chicken-and-egg with operations
//     which reference their `flow` — see the runner for two-pass ordering).
//
// This reconciler runs in TWO PHASES to break the cycle:
//   Phase 1 ("without-op"): POST/PATCH each flow with `operation: null`. This
//   lets operations be reconciled next with resolvable server flow IDs.
//   Phase 2 ("set-op"):     PATCH each flow's `operation` to the resolved
//   server operation id. Called after operations have been reconciled.

export interface FlowReconcileInput {
  flows: Record<string, unknown>[];
  identity: IdentityIndex;
  client: DirectusClient;
  opts: ApplyOptions;
}

async function listServerFlows(client: DirectusClient): Promise<Record<string, unknown>[]> {
  const raw = await client.get("/flows?limit=-1");
  if (raw === null) return [];
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const data = (raw as { data?: unknown }).data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function indexByName(rows: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const n = String((r as { name?: unknown }).name ?? "");
    if (n) map.set(n, r);
  }
  return map;
}

function stripSideEffects(obj: Record<string, unknown>): Record<string, unknown> {
  // Directus emits `operations` (junction ids) on GET but we manage ops in
  // their own reconciler. Also strip `user_created` etc. via sanitize.
  const { operations: _o, ...rest } = obj;
  return rest;
}

export async function reconcileFlowsPass1(
  input: FlowReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  const serverByName = indexByName(await listServerFlows(input.client));

  for (const desired of input.flows) {
    const name = String((desired as { name?: unknown }).name ?? "");
    if (!name) continue;
    const label = `flows/${name}`;
    const existing = serverByName.get(name) ?? null;
    const raw = sanitizeForWrite(desired);
    // Send with operation=null in the first pass so ops (which reference this
    // flow) can be created without racing the flow-op link.
    const payload = stripSideEffects({ ...raw, operation: null });

    if (existing === null) {
      if (!input.opts.dryRun) {
        try {
          await input.client.post("/flows", payload);
        } catch (e) {
          results.push({ kind: "flows", label, action: "failed", reason: (e as Error).message });
          continue;
        }
      }
      results.push({ kind: "flows", label, action: "created" });
      continue;
    }

    const existingStripped = stripSideEffects(existing);
    // Skip `operation` in this pass — it's handled by Pass 2.
    const { operation: _do, ...desiredForDiff } = payload;
    const { operation: _eo, ...existingForDiff } = existingStripped;
    if (diffSubset(desiredForDiff, existingForDiff)) {
      const id = String((existing as { id?: unknown }).id ?? "");
      if (!input.opts.dryRun) {
        try {
          await input.client.patch(`/flows/${id}`, desiredForDiff);
        } catch (e) {
          results.push({ kind: "flows", label, action: "failed", reason: (e as Error).message });
          continue;
        }
      }
      results.push({ kind: "flows", label, action: "updated" });
    } else {
      results.push({ kind: "flows", label, action: "unchanged" });
    }
  }
  return results;
}

// Pass 2: after operations are reconciled, set each flow's `operation` FK to
// the resolved server op id.
export async function reconcileFlowsPass2(
  input: FlowReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  const serverByName = indexByName(await listServerFlows(input.client));

  for (const desired of input.flows) {
    const name = String((desired as { name?: unknown }).name ?? "");
    if (!name) continue;
    const desiredOpSync = String((desired as { operation?: unknown }).operation ?? "");
    if (!desiredOpSync) continue; // flow with no entry op — nothing to link
    const existing = serverByName.get(name);
    if (!existing) continue; // Pass 1 already reported the failure
    const serverOpId = resolveOpSyncIdToServerId(desiredOpSync, input.identity);
    const currentOp = String((existing as { operation?: unknown }).operation ?? "");
    const label = `flows/${name} (link op)`;
    if (!serverOpId) {
      results.push({
        kind: "flows",
        label,
        action: "failed",
        reason: `unresolved entry op _syncId '${desiredOpSync}'`,
      });
      continue;
    }
    if (currentOp === serverOpId) {
      // already linked — no report entry (already counted in pass 1)
      continue;
    }
    if (!input.opts.dryRun) {
      const id = String((existing as { id?: unknown }).id ?? "");
      try {
        await input.client.patch(`/flows/${id}`, { operation: serverOpId });
      } catch (e) {
        results.push({ kind: "flows", label, action: "failed", reason: (e as Error).message });
        continue;
      }
    }
    results.push({ kind: "flows", label, action: "updated" });
  }
  return results;
}
