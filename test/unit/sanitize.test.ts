import { describe, expect, it } from "vitest";
import { sanitizeForWrite } from "../../src/sanitize.js";

describe("sanitizeForWrite", () => {
  it("strips top-level server-only keys", () => {
    const cleaned = sanitizeForWrite({
      _syncId: "abc",
      id: 42,
      date_created: "2026-01-01",
      collection: "listings",
      meta: { field: "title" },
    });
    expect(cleaned).toEqual({ collection: "listings", meta: { field: "title" } });
  });

  it("strips meta.id too", () => {
    const cleaned = sanitizeForWrite({
      field: "title",
      meta: { id: 999, field: "title", hidden: false },
    });
    expect(cleaned.meta).toEqual({ field: "title", hidden: false });
  });

  it("leaves meta null intact", () => {
    const cleaned = sanitizeForWrite({ field: "embedding", meta: null });
    expect(cleaned.meta).toBeNull();
  });
});
