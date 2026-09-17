import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";
import { gridsService } from "../service";
import * as publicResources from "../service/public-resources";
import { createBasesApi } from "./bases";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "platform-admin",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Platform",
  sn: "Admin",
  displayName: "Platform Admin",
  mail: null,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: ["22222222-2222-4222-8222-222222222222"],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

let listVisibleParams: unknown = null;

const requireAuthenticated: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  await next();
};

const resourceServiceAccount = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Grids base API",
  kind: "resource_bound" as const,
  status: "active" as const,
  delegatedUserId: null,
  appId: "grids",
  resourceType: "base",
  resourceId: "44444444-4444-4444-8444-444444444444",
  createdBy: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const requireServiceAccount =
  (scopes: string[]): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("actor", { kind: "service_account", serviceAccount: resourceServiceAccount, delegatedUser: null, scopes });
    c.set("accessSubject", { type: "service_account", serviceAccountId: resourceServiceAccount.id });
    await next();
  };

const requireDelegatedServiceAccount =
  (scopes: string[]): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("actor", {
      kind: "service_account",
      serviceAccount: {
        ...resourceServiceAccount,
        kind: "user_delegated",
        delegatedUserId: user.id,
        appId: null,
        resourceType: null,
        resourceId: null,
      },
      delegatedUser: user,
      scopes,
    });
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("user", user);
    await next();
  };

describe("Grids bases API", () => {
  beforeEach(() => {
    listVisibleParams = null;
    spyOn(gridsService.base, "listVisible").mockImplementation(async (params) => {
      listVisibleParams = params;
      return { items: [], total: 0 };
    });
  });

  afterEach(() => mock.restore());

  test("does not pass Cloud admin role as a listVisible bypass", async () => {
    const app = createBasesApi({ requireAuthenticated });

    const response = await app.request("/?q=finance&limit=25&offset=50");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ items: [], total: 0, limit: 25, offset: 50 });
    expect(listVisibleParams).toEqual({
      userId: user.id,
      userGroups: user.memberofGroupIds,
      serviceAccountId: null,
      query: "finance",
      limit: 25,
      offset: 50,
    });
  });

  test("limits resource-bound API listings to their bound base", async () => {
    const app = createBasesApi({ requireAuthenticated: requireServiceAccount(["grids:read"]) });

    const response = await app.request("/");

    expect(response.status).toBe(200);
    expect(listVisibleParams).toMatchObject({
      userId: null,
      userGroups: [],
      serviceAccountId: resourceServiceAccount.id,
      baseId: resourceServiceAccount.resourceId,
    });
  });

  test("rejects base listings when the credential lacks read scope", async () => {
    const app = createBasesApi({ requireAuthenticated: requireServiceAccount([]) });

    const response = await app.request("/");

    expect(response.status).toBe(403);
    expect(listVisibleParams).toBeNull();
  });

  test("rejects base creation from read-only and resource-bound credentials", async () => {
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Forbidden base" }),
    };

    expect((await createBasesApi({ requireAuthenticated: requireDelegatedServiceAccount(["read"]) }).request("/", request)).status).toBe(
      403,
    );
    expect((await createBasesApi({ requireAuthenticated: requireServiceAccount(["grids:*"]) }).request("/", request)).status).toBe(403);
  });

  test("creates a Base with document defaults through the canonical field", async () => {
    let createInput: unknown = null;
    spyOn(gridsService.base, "create").mockImplementation(async (input) => {
      createInput = input;
      return {
        ok: true,
        data: {
          id: "44444444-4444-4444-8444-444444444444",
          shortId: "BASE01",
          name: input.name,
          description: input.description ?? null,
          documentDefaults: input.documentDefaults ?? {},
          createdBy: user.id,
          deletedAt: null,
          createdAt: "2026-08-23T00:00:00.000Z",
          updatedAt: "2026-08-23T00:00:00.000Z",
        },
      };
    });

    const documentDefaults = {
      legalName: "Example GmbH",
      address: "  Main Street 1\nBuilding B ",
      postalCode: "89073",
      city: "Ulm",
      countryCode: "DE",
      taxId: "12/345/67890",
      vatId: "DE123456789",
      accountName: "Example GmbH",
    };
    const response = await createBasesApi({ requireAuthenticated }).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Invoices", documentDefaults }),
    });

    expect(response.status).toBe(201);
    expect(createInput).toEqual({
      name: "Invoices",
      description: null,
      documentDefaults,
    });
    expect(await response.json()).toMatchObject({ documentDefaults });
  });

  test("updating structured document defaults still requires Base admin grants", async () => {
    const baseId = "44444444-4444-4444-8444-444444444444";
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(baseId);
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockResolvedValue([]);
    const permission = spyOn(gridsService.permission, "resolve").mockReturnValue("write");
    const documentDefaults = {
      legalName: "Example GmbH",
      address: " Street 1\n",
      postalCode: "89073",
      city: "Ulm",
      countryCode: "DE",
      vatId: "DE123456789",
      accountName: "Example GmbH",
    };
    const update = spyOn(gridsService.base, "update").mockResolvedValue({
      ok: true,
      data: {
        id: baseId,
        shortId: "BASE01",
        name: "Invoices",
        description: null,
        documentDefaults,
        createdBy: user.id,
        deletedAt: null,
        createdAt: "2026-09-20T00:00:00.000Z",
        updatedAt: "2026-09-20T00:00:00.000Z",
      },
    });
    const app = createBasesApi({ requireAuthenticated });
    const request = { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ documentDefaults }) };
    expect((await app.request("/BASE01", request)).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
    permission.mockReturnValue("admin");
    const response = await app.request("/BASE01", request);
    expect(response.status).toBe(200);
    expect(update.mock.calls[0]?.slice(0, 3)).toEqual([baseId, { documentDefaults }, user.id]);
    expect(await response.json()).toMatchObject({ documentDefaults });
  });

  test("rejects the removed documentProfile Base field", async () => {
    const create = spyOn(gridsService.base, "create");
    const response = await createBasesApi({ requireAuthenticated }).request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Invoices", documentProfile: { legalName: "Legacy GmbH" } }),
    });

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
