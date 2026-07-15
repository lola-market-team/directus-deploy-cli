// diff_subset — true iff desired has any key/value that differs from (or is
// missing in) actual. The live Directus row usually carries server-only keys
// we don't manage (id, timestamps); we ignore those by asymmetric compare.

export function diffSubset(desired: unknown, actual: unknown): boolean {
  if (desired === null || desired === undefined) {
    // A null/undefined desired doesn't force a diff — the caller should
    // only pass in the block they intend to reconcile.
    return false;
  }
  if (typeof desired !== "object") {
    return desired !== actual;
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual)) return true;
    if (desired.length !== actual.length) return true;
    return desired.some((v, i) => diffSubset(v, actual[i]));
  }
  if (actual === null || actual === undefined || typeof actual !== "object" || Array.isArray(actual)) {
    return true;
  }
  const dObj = desired as Record<string, unknown>;
  const aObj = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(dObj)) {
    if (diffSubset(v, aObj[k])) return true;
  }
  return false;
}
