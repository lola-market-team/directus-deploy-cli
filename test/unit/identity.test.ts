import { describe, expect, it, vi } from "vitest";
import type { DirectusClient } from "../../src/types.js";
import {
  buildIdentity,
  resolvePolicySyncIdToServerId,
  resolveRoleSyncIdToServerId,
} from "../../src/identity.js";

function mockClient(policies: unknown[], roles: unknown[]): DirectusClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/policies")) return policies as Record<string, unknown>[];
      if (path.startsWith("/roles")) return roles as Record<string, unknown>[];
      return null;
    }),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    postRaw: vi.fn(async () => ({})),
  };
}

describe("identity", () => {
  it("resolves policy _syncId → server id via local name mapping", async () => {
    const local = [{ _syncId: "sync-admin", name: "Administrator" }];
    const server = [{ id: "server-admin-uuid", name: "Administrator" }];
    const idx = await buildIdentity(mockClient(server, []), local, []);
    expect(resolvePolicySyncIdToServerId("sync-admin", idx)).toBe("server-admin-uuid");
    expect(resolvePolicySyncIdToServerId("unknown", idx)).toBeNull();
  });

  it("resolves role _syncId → server id via local name mapping", async () => {
    const localRoles = [{ _syncId: "sync-editor", name: "Editor" }];
    const serverRoles = [{ id: "server-editor-uuid", name: "Editor" }];
    const idx = await buildIdentity(mockClient([], serverRoles), [], localRoles);
    expect(resolveRoleSyncIdToServerId("sync-editor", idx)).toBe("server-editor-uuid");
  });

  it("returns null when local sync is present but server has no matching name", async () => {
    const local = [{ _syncId: "sync-x", name: "Ghost" }];
    const idx = await buildIdentity(mockClient([], []), local, []);
    expect(resolvePolicySyncIdToServerId("sync-x", idx)).toBeNull();
  });

  it("uses UUID identity first so name collisions don't collapse two policies", async () => {
    // Two policies share the exact same name — this is real in the wild
    // (Codegen Web x2 on lola-market-backend). Prior name-only resolution
    // sent both local rows to the same server row, causing permission
    // oscillation on every `apply`. UUID-first resolution fixes that.
    const localA = { _syncId: "a27b3dd9-2a14-43c1-bb93-3ae01606f936", name: "Codegen Web" };
    const localB = { _syncId: "d57376cc-7e1c-4ccf-b211-6f041e4cb36f", name: "Codegen Web" };
    const serverA = { id: "a27b3dd9-2a14-43c1-bb93-3ae01606f936", name: "Codegen Web" };
    const serverB = { id: "d57376cc-7e1c-4ccf-b211-6f041e4cb36f", name: "Codegen Web" };
    const idx = await buildIdentity(mockClient([serverA, serverB], []), [localA, localB], []);
    expect(resolvePolicySyncIdToServerId(localA._syncId, idx)).toBe(serverA.id);
    expect(resolvePolicySyncIdToServerId(localB._syncId, idx)).toBe(serverB.id);
  });
});
