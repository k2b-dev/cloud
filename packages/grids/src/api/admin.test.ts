import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@valentinkolb/cloud/contracts";
import type { AuthContext } from "@valentinkolb/cloud/server";
import type { MiddlewareHandler } from "hono";
import { gridsService } from "../service";
import { createAdminApi } from "./admin";

const baseId = "11111111-1111-4111-8111-111111111111";
const basePublicId = "BASE01";
const otherBaseId = "22222222-2222-4222-8222-222222222222";
const customAppId = "33333333-3333-4333-8333-333333333333";
const customAppPublicId = "APP001";
const baseAccessId = "44444444-4444-4444-8444-444444444444";
const tableAccessId = "55555555-5555-4555-8555-555555555555";
const createdAccessId = "66666666-6666-4666-8666-666666666666";

const user: User = {
  id: "77777777-7777-4777-8777-777777777777",
  uid: "admin-user",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Admin",
  sn: "User",
  displayName: "Admin User",
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

const base = {
  id: baseId,
  shortId: basePublicId,
  name: "Admin Base",
  description: null,
  documentDefaults: {},
  createdBy: user.id,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const baseEntry = {
  id: baseAccessId,
  principal: { type: "authenticated" as const },
  permission: "admin" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  resourceType: "base" as const,
  resourceId: baseId,
  resourceName: base.name,
  tableId: null,
  tableName: null,
};

const childEntry = {
  id: tableAccessId,
  principal: { type: "authenticated" as const },
  permission: "none" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  resourceType: "customApp" as const,
  resourceId: customAppId,
  resourceName: "Published App",
  tableId: null,
  tableName: null,
};

const createdEntry = {
  id: createdAccessId,
  principal: { type: "authenticated" as const },
  permission: "read" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

let isPlatformAdmin = true;
let baseGetCalls = 0;
let grantCalls: unknown[] = [];
let updateCalls: unknown[] = [];
let revokeCalls: unknown[] = [];
let removedBaseId: string | null = null;

const requireAdmin: MiddlewareHandler<AuthContext> = async (c, next) => {
  if (!isPlatformAdmin) return c.json({ message: "Forbidden" }, 403);
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  await next();
};

const app = () =>
  createAdminApi({
    requireAdmin,
    resolvePublicId: async (type, publicId) => (type === "base" && publicId === basePublicId ? baseId : null),
    projectPublicIds: async (type, ids) => {
      const projected = new Map<string, string>();
      for (const id of ids) {
        if (type === "base" && id === baseId) projected.set(id, basePublicId);
        if (type === "customApp" && id === customAppId) projected.set(id, customAppPublicId);
      }
      return projected;
    },
  });

const jsonRequest = (method: "POST" | "PATCH", body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("Grids admin API", () => {
  beforeEach(() => {
    isPlatformAdmin = true;
    baseGetCalls = 0;
    grantCalls = [];
    updateCalls = [];
    revokeCalls = [];
    removedBaseId = null;
    spyOn(gridsService.base, "get").mockImplementation(async (id) => {
      baseGetCalls += 1;
      return id === baseId ? base : null;
    });
    spyOn(gridsService.base, "remove").mockImplementation(async (id, actorId) => {
      removedBaseId = `${id}:${actorId}`;
      return { ok: true, data: undefined };
    });
    spyOn(gridsService.access, "listForBaseTree").mockImplementation(async () => [baseEntry, childEntry]);
    spyOn(gridsService.access, "listForBase").mockImplementation(async () => [createdEntry]);
    spyOn(gridsService.access, "grant").mockImplementation(async (params) => {
      grantCalls.push(params);
      return { ok: true, data: { accessId: createdAccessId } };
    });
    spyOn(gridsService.access, "resolveBinding").mockImplementation(async (accessId) => {
      if (accessId === baseAccessId) return { resourceType: "base", baseId };
      if (accessId === tableAccessId) return { resourceType: "customApp", baseId, customAppId };
      return { resourceType: "base", baseId: otherBaseId };
    });
    spyOn(gridsService.access, "updateLevel").mockImplementation(async (...args) => {
      updateCalls.push(args);
      return { ok: true, data: undefined };
    });
    spyOn(gridsService.access, "revoke").mockImplementation(async (...args) => {
      revokeCalls.push(args);
      return { ok: true, data: undefined };
    });
  });

  afterEach(() => mock.restore());

  test("rejects non-platform-admin callers before reading base data", async () => {
    isPlatformAdmin = false;

    const response = await app().request(`/bases/${basePublicId}/access`);

    expect(response.status).toBe(403);
    expect(baseGetCalls).toBe(0);
  });

  test("lists base and Grids App ACL entries for platform admins", async () => {
    const response = await app().request(`/bases/${basePublicId}/access`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([
      { ...baseEntry, resourceId: basePublicId },
      { ...childEntry, resourceId: customAppPublicId },
    ]);
  });

  test("creates base grants and returns the created access entry", async () => {
    const response = await app().request(
      `/bases/${basePublicId}/access`,
      jsonRequest("POST", { principal: { type: "authenticated" }, permission: "read" }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual(createdEntry);
    expect(grantCalls).toEqual([
      {
        resourceType: "base",
        resourceId: baseId,
        actorId: user.id,
        principal: { type: "authenticated" },
        permission: "read",
      },
    ]);
  });

  test("can update Grids App ACLs inside the requested base", async () => {
    const response = await app().request(`/bases/${basePublicId}/access/${tableAccessId}`, jsonRequest("PATCH", { permission: "read" }));

    expect(response.status).toBe(204);
    expect(updateCalls).toEqual([[tableAccessId, "read", user.id]]);
  });

  test("rejects invalid Grids App ACL levels in the admin repair route", async () => {
    const response = await app().request(`/bases/${basePublicId}/access/${tableAccessId}`, jsonRequest("PATCH", { permission: "admin" }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({ message: "Grids App grants only accept 'read' or 'none'." });
    expect(updateCalls).toEqual([]);
  });

  test("does not update ACLs from another base", async () => {
    const response = await app().request(
      `/bases/${basePublicId}/access/99999999-9999-4999-8999-999999999999`,
      jsonRequest("PATCH", { permission: "read" }),
    );

    expect(response.status).toBe(404);
    expect(updateCalls).toEqual([]);
  });

  test("can revoke Grids App ACLs inside the requested base", async () => {
    const response = await app().request(`/bases/${basePublicId}/access/${tableAccessId}`, { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(revokeCalls).toEqual([[tableAccessId, user.id]]);
  });

  test("deletes bases only through the admin route", async () => {
    const response = await app().request(`/bases/${basePublicId}`, { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(removedBaseId).toBe(`${baseId}:${user.id}`);
  });

  test("rejects UUID and five-character base route identifiers", async () => {
    expect((await app().request(`/bases/${baseId}/access`)).status).toBe(404);
    expect((await app().request("/bases/ABCDE/access")).status).toBe(404);
    expect(baseGetCalls).toBe(0);
  });
});
