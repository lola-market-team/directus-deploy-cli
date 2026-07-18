import { describe, expect, it, vi } from "vitest";
import type { DirectusClient } from "../../src/types.js";
import { reconcileRoles } from "../../src/reconcilers/roles.js";
import { reconcilePolicies } from "../../src/reconcilers/policies.js";
import { reconcilePermissions } from "../../src/reconcilers/permissions.js";
import type { IdentityIndex } from "../../src/identity.js";

function mkClient(overrides: Partial<DirectusClient> = {}): DirectusClient {
  return {
    get: vi.fn(async () => null),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    delete: vi.fn(async () => undefined),
    postRaw: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe("reconcileRoles", () => {
  it("creates a role that doesn't exist on the server", async () => {
    const client = mkClient({ get: vi.fn(async () => []) });
    const results = await reconcileRoles({
      roles: [{ name: "Editor", icon: "edit" }],
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("created");
    expect(client.post).toHaveBeenCalledWith("/roles", { name: "Editor", icon: "edit" });
  });

  it("leaves an unchanged role alone", async () => {
    const client = mkClient({
      get: vi.fn(async () => [{ id: "server-x", name: "Editor", icon: "edit" }]),
    });
    const results = await reconcileRoles({
      roles: [{ name: "Editor", icon: "edit" }],
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("unchanged");
    expect(client.patch).not.toHaveBeenCalled();
  });

  it("PATCHes when the icon changes", async () => {
    const client = mkClient({
      get: vi.fn(async () => [{ id: "server-x", name: "Editor", icon: "old" }]),
    });
    await reconcileRoles({
      roles: [{ name: "Editor", icon: "new" }],
      client,
      opts: { dryRun: false },
    });
    expect(client.patch).toHaveBeenCalledWith("/roles/server-x", { name: "Editor", icon: "new" });
  });
});

function fakeIdentity(): IdentityIndex {
  return {
    policySyncIdToName: new Map([["sync-p", "PolicyA"]]),
    roleSyncIdToName: new Map([["sync-r", "RoleA"]]),
    serverPolicyIdByName: new Map([["PolicyA", "server-policy-A"]]),
    serverRoleIdByName: new Map([["RoleA", "server-role-A"]]),
    serverPolicyIds: new Set(),
    serverRoleIds: new Set(),
    flowSyncIdToName: new Map(),
    serverFlowIdByName: new Map(),
    serverFlowIds: new Set(),
    opSyncIdToFlowAndKey: new Map(),
    serverOpIdByFlowIdAndKey: new Map(),
    serverOpIds: new Set(),
  };
}

describe("reconcilePolicies", () => {
  it("resolves role _syncId inside `roles` before POSTing", async () => {
    const client = mkClient({ get: vi.fn(async () => []) });
    await reconcilePolicies({
      policies: [
        {
          _syncId: "new-policy",
          name: "NewPolicy",
          admin_access: false,
          app_access: true,
          roles: [{ role: "sync-r", sort: null, user: null }],
        },
      ],
      identity: fakeIdentity(),
      client,
      opts: { dryRun: false },
    });
    const body = (client.post as ReturnType<typeof vi.fn>).mock.calls[0][1] as {
      roles: unknown;
    };
    expect(body.roles).toEqual([{ role: "server-role-A", sort: null, user: null }]);
  });

  it("fails a policy when a nested role _syncId can't be resolved", async () => {
    const client = mkClient({ get: vi.fn(async () => []) });
    const results = await reconcilePolicies({
      policies: [
        {
          _syncId: "x",
          name: "Broken",
          roles: [{ role: "unknown-sync", sort: null, user: null }],
        },
      ],
      identity: fakeIdentity(),
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("failed");
    expect(results[0]!.reason).toMatch(/unresolved role _syncId/);
  });

  it("ignores server-side `roles`/`users` when computing drift", async () => {
    const client = mkClient({
      get: vi.fn(async () => [
        {
          id: "server-uuid",
          name: "PolicyA",
          admin_access: false,
          app_access: true,
          roles: ["some-junction-id-a", "some-junction-id-b"],
          users: ["some-user-id"],
          permissions: [1, 2, 3],
        },
      ]),
    });
    const results = await reconcilePolicies({
      policies: [
        {
          _syncId: "sync-p",
          name: "PolicyA",
          admin_access: false,
          app_access: true,
          roles: [],
        },
      ],
      identity: fakeIdentity(),
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("unchanged");
  });
});

describe("reconcilePermissions", () => {
  it("resolves policy _syncId and matches by composite key", async () => {
    const server = [
      {
        id: 42,
        collection: "listings",
        action: "read",
        policy: "server-policy-A",
        fields: ["*"],
      },
    ];
    const client = mkClient({ get: vi.fn(async () => server) });
    const results = await reconcilePermissions({
      permissions: [
        {
          _syncId: "p1",
          collection: "listings",
          action: "read",
          policy: "sync-p",
          fields: ["*"],
        },
      ],
      identity: fakeIdentity(),
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("unchanged");
  });

  it("PATCHes when fields differ", async () => {
    const server = [
      {
        id: 42,
        collection: "listings",
        action: "read",
        policy: "server-policy-A",
        fields: ["id"],
      },
    ];
    const client = mkClient({ get: vi.fn(async () => server) });
    await reconcilePermissions({
      permissions: [
        {
          _syncId: "p1",
          collection: "listings",
          action: "read",
          policy: "sync-p",
          fields: ["*"],
        },
      ],
      identity: fakeIdentity(),
      client,
      opts: { dryRun: false },
    });
    expect(client.patch).toHaveBeenCalledWith(
      "/permissions/42",
      expect.objectContaining({ fields: ["*"], policy: "server-policy-A" }),
    );
  });

  it("fails a permission when its policy _syncId can't be resolved", async () => {
    const client = mkClient({ get: vi.fn(async () => []) });
    const results = await reconcilePermissions({
      permissions: [
        {
          collection: "x",
          action: "read",
          policy: "unknown-sync",
        },
      ],
      identity: fakeIdentity(),
      client,
      opts: { dryRun: false },
    });
    expect(results[0]!.action).toBe("failed");
    expect(results[0]!.reason).toMatch(/unresolved policy _syncId/);
  });
});
