// Strip server-managed keys from a payload before POST/PATCH.
// Directus in practice ignores unknown top-level keys on writes, but sending
// Tractr's `_syncId` or stale timestamps is confusing at best and could break
// on a future Directus release. Also recursively cleans nested `meta` which
// carries its own auto-id in some entity kinds.

const SERVER_ONLY_KEYS = new Set([
  "_syncId",
  "id",
  "date_created",
  "user_created",
  "date_updated",
  "user_updated",
]);

function stripKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SERVER_ONLY_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

export function sanitizeForWrite(payload: Record<string, unknown>): Record<string, unknown> {
  const cleaned = stripKeys(payload);
  const meta = cleaned["meta"];
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    cleaned["meta"] = stripKeys(meta as Record<string, unknown>);
  }
  return cleaned;
}
