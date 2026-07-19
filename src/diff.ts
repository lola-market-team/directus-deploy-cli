// diffSubset — reports the first key/value where `desired` differs from (or
// is missing in) `actual`. The live Directus row usually carries server-only
// keys we don't manage (id, timestamps); we ignore those by asymmetric
// compare.
//
// Returns null when no diff. Returns a DiffPath breadcrumb otherwise, so
// callers can render "meta.hidden: false → true" instead of a nameless
// UPDATED line. Path is built by prepending keys as recursion unwinds.

export interface DiffPath {
  path: string[];
  desired: unknown;
  actual: unknown;
}

export function diffSubset(desired: unknown, actual: unknown): DiffPath | null {
  if (desired === null || desired === undefined) {
    // A null/undefined desired doesn't force a diff — the caller should
    // only pass in the block they intend to reconcile.
    return null;
  }
  if (typeof desired !== "object") {
    return desired === actual ? null : { path: [], desired, actual };
  }
  if (Array.isArray(desired)) {
    if (!Array.isArray(actual)) return { path: [], desired, actual };
    if (desired.length !== actual.length) return { path: [], desired, actual };
    for (let i = 0; i < desired.length; i++) {
      const child = diffSubset(desired[i], actual[i]);
      if (child) return { ...child, path: [String(i), ...child.path] };
    }
    return null;
  }
  if (actual === null || actual === undefined || typeof actual !== "object" || Array.isArray(actual)) {
    return { path: [], desired, actual };
  }
  const dObj = desired as Record<string, unknown>;
  const aObj = actual as Record<string, unknown>;
  for (const [k, v] of Object.entries(dObj)) {
    const child = diffSubset(v, aObj[k]);
    if (child) return { ...child, path: [k, ...child.path] };
  }
  return null;
}

// Render a DiffPath as a single line: "meta.hidden: false → true". Complex
// nested objects/arrays get JSON-stringified and truncated so the reason
// line stays readable in a terminal.
export function formatDiffPath(dp: DiffPath): string {
  const key = dp.path.length > 0 ? dp.path.join(".") : "(root)";
  return `${key}: ${renderValue(dp.actual)} → ${renderValue(dp.desired)}`;
}

function renderValue(v: unknown): string {
  if (v === undefined) return "<missing>";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = JSON.stringify(v);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
}
