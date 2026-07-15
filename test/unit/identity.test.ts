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
});
