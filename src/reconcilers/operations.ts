import type { ApplyOptions, DirectusClient, EntityResult } from "../types.js";
import { diffSubset } from "../diff.js";
import { sanitizeForWrite } from "../sanitize.js";
import type { IdentityIndex } from "../identity.js";
import {
  resolveFlowSyncIdToServerId,
  resolveOpSyncIdToServerId,
} from "../identity.js";

// Operations. Composite identity `(flow_name, key)`. UUID PK. Cross-refs:
//   - `flow`   : the parent flow's _syncId — must resolve
//   - `resolve`, `reject` : other operations' _syncIds — forward references
//     are possible within a single flow, so we run in TWO PASSES:
//     Pass 1: POST/PATCH ops with resolve=null and reject=null; sets `flow`.
//     Pass 2: re-fetch identity (so newly-created ops become resolvable) and
//     PATCH resolve/reject on ops whose refs are non-null.

export interface OperationReconcileInput {
  operations: Record<string, unknown>[];
  identity: IdentityIndex;
  client: DirectusClient;
  opts: ApplyOptions;
}

async function listServerOps(client: DirectusClient): Promise<Record<string, unknown>[]> {
  const raw = await client.get("/operations?limit=-1");
  if (raw === null) return [];
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  const data = (raw as { data?: unknown }).data;
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

function indexByFlowAndKey(
  rows: Record<string, unknown>[],
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const flow = String((r as { flow?: unknown }).flow ?? "");
    const key = String((r as { key?: unknown }).key ?? "");
    if (flow && key) map.set(`${flow}::${key}`, r);
  }
  return map;
}

export async function reconcileOperationsPass1(
  input: OperationReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  const serverByCompositeKey = indexByFlowAndKey(await listServerOps(input.client));

  for (const desired of input.operations) {
    const opKey = String((desired as { key?: unknown }).key ?? "");
    const flowSyncId = String((desired as { flow?: unknown }).flow ?? "");
    if (!opKey || !flowSyncId) continue;
    const label = `operations/${flowSyncId.slice(0, 8)}…/${opKey}`;

    const serverFlowId = resolveFlowSyncIdToServerId(flowSyncId, input.identity);
    if (!serverFlowId) {
      results.push({
        kind: "operations",
        label,
        action: "failed",
        reason: `unresolved flow _syncId '${flowSyncId}' — apply flows first`,
      });
      continue;
    }

    const payload: Record<string, unknown> = {
      ...sanitizeForWrite(desired),
      flow: serverFlowId,
      // First pass: null out the intra-flow refs; Pass 2 will PATCH them.
      resolve: null,
      reject: null,
    };

    const existing = serverByCompositeKey.get(`${serverFlowId}::${opKey}`) ?? null;

    if (existing === null) {
      if (!input.opts.dryRun) {
        try {
          await input.client.post("/operations", payload);
        } catch (e) {
          results.push({
            kind: "operations",
            label,
            action: "failed",
            reason: (e as Error).message,
          });
          continue;
        }
      }
      results.push({ kind: "operations", label, action: "created" });
      continue;
    }

    // Skip resolve/reject in diff — Pass 2 handles those.
    const { resolve: _dr, reject: _dj, ...desiredForDiff } = payload;
    const { resolve: _er, reject: _ej, ...existingForDiff } = existing;
    if (diffSubset(desiredForDiff, existingForDiff)) {
      const id = String((existing as { id?: unknown }).id ?? "");
      if (!input.opts.dryRun) {
        try {
          await input.client.patch(`/operations/${id}`, desiredForDiff);
        } catch (e) {
          results.push({
            kind: "operations",
            label,
            action: "failed",
            reason: (e as Error).message,
          });
          continue;
        }
      }
      results.push({ kind: "operations", label, action: "updated" });
    } else {
      results.push({ kind: "operations", label, action: "unchanged" });
    }
  }
  return results;
}

export async function reconcileOperationsPass2(
  input: OperationReconcileInput,
): Promise<EntityResult[]> {
  const results: EntityResult[] = [];
  const serverByCompositeKey = indexByFlowAndKey(await listServerOps(input.client));

  for (const desired of input.operations) {
    const opKey = String((desired as { key?: unknown }).key ?? "");
    const flowSyncId = String((desired as { flow?: unknown }).flow ?? "");
    if (!opKey || !flowSyncId) continue;

    const resolveSync = (desired as { resolve?: unknown }).resolve;
    const rejectSync = (desired as { reject?: unknown }).reject;
    if (resolveSync == null && rejectSync == null) continue; // nothing to link

    const label = `operations/${flowSyncId.slice(0, 8)}…/${opKey} (link refs)`;
    const serverFlowId = resolveFlowSyncIdToServerId(flowSyncId, input.identity);
    if (!serverFlowId) continue; // Pass 1 already flagged this

    const existing = serverByCompositeKey.get(`${serverFlowId}::${opKey}`);
    if (!existing) continue; // Pass 1 already flagged

    const resolveTarget = resolveSync
      ? resolveOpSyncIdToServerId(String(resolveSync), input.identity)
      : null;
    const rejectTarget = rejectSync
      ? resolveOpSyncIdToServerId(String(rejectSync), input.identity)
      : null;

    if (resolveSync && !resolveTarget) {
      results.push({
        kind: "operations",
        label,
        action: "failed",
        reason: `unresolved resolve _syncId '${resolveSync}'`,
      });
      continue;
    }
    if (rejectSync && !rejectTarget) {
      results.push({
        kind: "operations",
        label,
        action: "failed",
        reason: `unresolved reject _syncId '${rejectSync}'`,
      });
      continue;
    }

    const currentResolve = (existing as { resolve?: unknown }).resolve ?? null;
    const currentReject = (existing as { reject?: unknown }).reject ?? null;
    if (currentResolve === resolveTarget && currentReject === rejectTarget) continue;

    if (!input.opts.dryRun) {
      const id = String((existing as { id?: unknown }).id ?? "");
      try {
        await input.client.patch(`/operations/${id}`, {
          resolve: resolveTarget,
          reject: rejectTarget,
        });
      } catch (e) {
        results.push({
          kind: "operations",
          label,
          action: "failed",
          reason: (e as Error).message,
        });
        continue;
      }
    }
    results.push({ kind: "operations", label, action: "updated" });
  }
  return results;
}
