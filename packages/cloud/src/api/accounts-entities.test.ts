import { describe, expect, spyOn, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import type { AuthContext } from "../server";
import { audit } from "../services/audit";
import { createAccountsEntitiesRoutes } from "./accounts-entities";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const authenticateAs =
  (profile: "user" | "guest"): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    const user = {
      id: USER_ID,
      uid: "entity-viewer",
      provider: "local",
      profile,
      roles: [profile, "local", `local/${profile}`],
    } as AuthContext["Variables"]["user"];
    c.set("actor", { kind: "user", user });
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("user", user);
    await next();
  };

describe("accounts entity routes", () => {
  test("passes an authenticated guest actor to the scoped entity service", async () => {
    let actor: unknown;
    let exactIds: unknown;
    const routes = createAccountsEntitiesRoutes({
      authenticate: authenticateAs("guest"),
      listEntities: async (input) => {
        actor = input.actor;
        exactIds = { userIds: input.userIds, groupIds: input.groupIds };
        return { items: [], page: 1, perPage: 10, total: 0, hasNext: false };
      },
    });

    const response = await routes.request(
      "/entities?per_page=10&user_ids=11111111-1111-4111-8111-111111111111&group_ids=33333333-3333-4333-8333-333333333333",
    );
    expect(response.status).toBe(200);
    expect(actor).toMatchObject({ userId: USER_ID, roles: ["guest", "local", "local/guest"] });
    expect(exactIds).toEqual({
      userIds: ["11111111-1111-4111-8111-111111111111"],
      groupIds: ["33333333-3333-4333-8333-333333333333"],
    });
  });

  test("validates and forwards optional service-account kind and status filters", async () => {
    const seen: unknown[] = [];
    const routes = createAccountsEntitiesRoutes({
      authenticate: authenticateAs("user"),
      requireUser,
      listEntities: async (input) => {
        seen.push({ kinds: input.serviceAccountKinds, status: input.serviceAccountStatus });
        return { items: [], page: 1, perPage: 10, total: 0, hasNext: false };
      },
    });

    expect((await routes.request("/entities")).status).toBe(200);
    expect((await routes.request("/entities?service_account_kinds=standalone,agent,standalone&service_account_status=active")).status).toBe(
      200,
    );
    expect(
      (await routes.request("/entities?service_account_kinds=user_delegated,resource_bound&service_account_status=disabled")).status,
    ).toBe(200);
    expect((await routes.request("/entities?service_account_kinds=%20,%20")).status).toBe(200);
    expect(seen).toEqual([
      { kinds: undefined, status: undefined },
      { kinds: ["standalone", "agent"], status: "active" },
      { kinds: ["user_delegated", "resource_bound"], status: "disabled" },
      { kinds: undefined, status: undefined },
    ]);
    for (const query of [
      "service_account_kinds=agent,unknown",
      "service_account_status=enabled",
      "service_account_status=active,disabled",
    ]) {
      expect((await routes.request(`/entities?${query}`)).status).toBe(400);
    }
    expect(seen).toHaveLength(4);
  });

  test("leaves personal Linux groups out unless include_personal=true", async () => {
    const seen: unknown[] = [];
    const routes = createAccountsEntitiesRoutes({
      authenticate: authenticateAs("user"),
      listEntities: async (input) => {
        seen.push(input.includePersonal);
        return { items: [], page: 1, perPage: 10, total: 0, hasNext: false };
      },
    });

    expect((await routes.request("/entities?kinds=group&search=qd")).status).toBe(200);
    expect((await routes.request("/entities?kinds=group&search=qd&include_personal=true")).status).toBe(200);
    expect((await routes.request("/entities?include_personal=yes")).status).toBe(400);
    expect(seen).toEqual([false, true]);
  });

  test("rejects relation filters for guest actors before querying entities", async () => {
    let queried = false;
    const routes = createAccountsEntitiesRoutes({
      authenticate: authenticateAs("guest"),
      listEntities: async () => {
        queried = true;
        return { items: [], page: 1, perPage: 10, total: 0, hasNext: false };
      },
    });

    const response = await routes.request("/entities?parent_group_id=33333333-3333-4333-8333-333333333333");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "FORBIDDEN",
      message: "Guest accounts cannot use entity relation filters",
    });
    expect(queried).toBe(false);
  });

  test("withholds group members, as the access editor requests them, from guest actors", async () => {
    let queried = false;
    const routes = createAccountsEntitiesRoutes({
      authenticate: authenticateAs("guest"),
      listEntities: async () => {
        queried = true;
        return { items: [], page: 1, perPage: 20, total: 0, hasNext: false };
      },
    });

    const response = await routes.request(
      "/entities?kinds=user&member_of_group_id=33333333-3333-4333-8333-333333333333&recursive=true&page=1&per_page=20",
    );
    expect(response.status).toBe(403);
    expect(queried).toBe(false);
  });

  test("keeps anonymous callers at 401 and resource-bound service accounts at 403", async () => {
    const anonymous = createAccountsEntitiesRoutes({
      authenticate: async (c) => c.json({ code: "UNAUTHORIZED", message: "Authentication required" }, 401),
    });
    expect((await anonymous.request("/entities")).status).toBe(401);

    const serviceAccount = createAccountsEntitiesRoutes({
      authenticate: async (c, next) => {
        c.set("actor", {
          kind: "service_account",
          serviceAccount: {
            id: "22222222-2222-4222-8222-222222222222",
            name: "Entity integration",
            kind: "resource_bound",
            status: "active",
            delegatedUserId: null,
            appId: "accounts",
            resourceType: "entities",
            resourceId: "directory",
            createdBy: null,
            createdAt: "2026-10-23T00:00:00.000Z",
          },
          delegatedUser: null,
          scopes: ["read"],
        });
        c.set("accessSubject", { type: "service_account", serviceAccountId: "22222222-2222-4222-8222-222222222222" });
        await next();
      },
    });
    // Exercise the real denial policy while keeping its durable audit out of this unit fixture.
    const record = spyOn(audit, "recordResult").mockImplementation(async (params) => params.result);
    try {
      expect((await serviceAccount.request("/entities")).status).toBe(403);
      expect(record).toHaveBeenCalledTimes(1);
      expect(record.mock.calls[0]![0].result.ok).toBe(false);
    } finally {
      record.mockRestore();
    }
  });
});
