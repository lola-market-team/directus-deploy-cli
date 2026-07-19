import { describe, expect, it } from "vitest";
import { diffSubset, formatDiffPath } from "../../src/diff.js";

describe("diffSubset", () => {
  it("returns null when desired is a subset of actual", () => {
    expect(diffSubset({ a: 1 }, { a: 1, b: 2 })).toBeNull();
  });

  it("detects a scalar diff with path + values", () => {
    expect(diffSubset({ a: 1 }, { a: 2 })).toEqual({ path: ["a"], desired: 1, actual: 2 });
  });

  it("detects a missing key", () => {
    expect(diffSubset({ a: 1 }, { b: 2 })).toEqual({ path: ["a"], desired: 1, actual: undefined });
  });

  it("recurses into nested objects and builds full path", () => {
    expect(diffSubset({ meta: { hidden: true } }, { meta: { hidden: false } })).toEqual({
      path: ["meta", "hidden"],
      desired: true,
      actual: false,
    });
    expect(diffSubset({ meta: { hidden: true } }, { meta: { hidden: true, extra: 1 } })).toBeNull();
  });

  it("arrays: mismatched length returns whole-array diff at index path", () => {
    const dp = diffSubset({ xs: [1, 2] }, { xs: [1, 2, 3] });
    expect(dp).not.toBeNull();
    expect(dp!.path).toEqual(["xs"]);
  });

  it("arrays: same length, different element pinpoints the index", () => {
    const dp = diffSubset({ xs: [1, 2] }, { xs: [1, 3] });
    expect(dp).toEqual({ path: ["xs", "1"], desired: 2, actual: 3 });
  });

  it("arrays: exact match is null", () => {
    expect(diffSubset({ xs: [1, 2] }, { xs: [1, 2] })).toBeNull();
  });

  it("no diff when desired is null/undefined", () => {
    expect(diffSubset(null, { a: 1 })).toBeNull();
    expect(diffSubset(undefined, { a: 1 })).toBeNull();
  });

  it("actual null against desired object is a whole-object diff", () => {
    const dp = diffSubset({ a: 1 }, null);
    expect(dp).not.toBeNull();
    expect(dp!.path).toEqual([]);
  });
});

describe("formatDiffPath", () => {
  it("renders scalar path with actual → desired", () => {
    expect(formatDiffPath({ path: ["hidden"], desired: true, actual: false }))
      .toBe("hidden: false → true");
  });

  it("dots multi-level path", () => {
    expect(formatDiffPath({ path: ["meta", "options", "template"], desired: "a", actual: "b" }))
      .toBe('meta.options.template: "b" → "a"');
  });

  it("marks missing keys", () => {
    expect(formatDiffPath({ path: ["a"], desired: 1, actual: undefined }))
      .toBe("a: <missing> → 1");
  });

  it("truncates overlong nested values", () => {
    const long = { a: "x".repeat(100) };
    const s = formatDiffPath({ path: ["k"], desired: long, actual: null });
    expect(s.endsWith("...")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(80);
  });

  it("(root) label when path is empty", () => {
    expect(formatDiffPath({ path: [], desired: 1, actual: 2 })).toBe("(root): 2 → 1");
  });
});
