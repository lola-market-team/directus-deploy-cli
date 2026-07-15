import { describe, expect, it } from "vitest";
import { diffSubset } from "../../src/diff.js";

describe("diffSubset", () => {
  it("returns false when desired is a subset of actual", () => {
    expect(diffSubset({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("detects a scalar diff", () => {
    expect(diffSubset({ a: 1 }, { a: 2 })).toBe(true);
  });

  it("detects a missing key", () => {
    expect(diffSubset({ a: 1 }, { b: 2 })).toBe(true);
  });

  it("recurses into nested objects", () => {
    expect(diffSubset({ meta: { hidden: true } }, { meta: { hidden: false } })).toBe(true);
    expect(diffSubset({ meta: { hidden: true } }, { meta: { hidden: true, extra: 1 } })).toBe(false);
  });

  it("treats arrays by index equality", () => {
    expect(diffSubset({ xs: [1, 2] }, { xs: [1, 2, 3] })).toBe(true);
    expect(diffSubset({ xs: [1, 2] }, { xs: [1, 3] })).toBe(true);
    expect(diffSubset({ xs: [1, 2] }, { xs: [1, 2] })).toBe(false);
  });

  it("no diff when desired is null/undefined", () => {
    expect(diffSubset(null, { a: 1 })).toBe(false);
    expect(diffSubset(undefined, { a: 1 })).toBe(false);
  });

  it("actual null against desired object is a diff", () => {
    expect(diffSubset({ a: 1 }, null)).toBe(true);
  });
});
