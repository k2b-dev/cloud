import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import type { MiddlewareHandler } from "hono";
import { gridsService } from "../service";
import { createGqlApi } from "./gql";
import * as gqlRuntime from "./gql-runtime";

const user: User = {
  id: "44444444-4444-4444-8444-444444444444",
  uid: "assistant-user",
  roles: ["user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Assistant",
  sn: "User",
  displayName: "Assistant User",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
};

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  shortId: "BASE01",
  name: "Assistant Base",
  description: "Visible schema.",
  createdBy: user.id,
  deletedAt: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

const table = { kind: "table" as const, id: "22222222-2222-4222-8222-222222222222", shortId: "ITEM01", name: "Items" };

const visibleField = {
  id: "33333333-3333-4333-8333-333333333333",
  shortId: "NAME01",
  tableId: table.id,
  name: "Name",
  description: "Display name.",
  icon: null,
  type: "text",
  config: {},
  position: 0,
  required: false,
  presentable: true,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};

let baseAccess: "none" | "read" = "read";
let contextRequested = false;

const authenticated: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  await next();
};

describe("GQL assistant download routes", () => {
  beforeEach(() => {
    baseAccess = "read";
    contextRequested = false;
    spyOn(gridsService.base, "get").mockImplementation(async () => base as never);
    spyOn(gridsService.permission, "loadBaseGrantsForSubject").mockImplementation(async () => []);
    spyOn(gridsService.permission, "resolve").mockImplementation(() => baseAccess);
    spyOn(gqlRuntime, "buildPermissionedGqlResolverContext").mockImplementation(async () => {
      contextRequested = true;
      return {
        currentTable: table,
        tables: [table],
        views: [],
        fieldsByTableId: { [table.id]: [visibleField] },
      } as never;
    });
  });

  afterEach(() => mock.restore());

  test("downloads SKILL.md as markdown attachment", async () => {
    const app = createGqlApi({ requireAuthenticated: authenticated, resolveId: async () => base.id });

    const response = await app.request(`/by-base/${base.shortId}/assistant/SKILL.md`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="SKILL.md"');
    expect(body).toContain("# Grids GQL Assistant Skill");
  });

  test("downloads permission-shaped context.md as markdown attachment", async () => {
    const app = createGqlApi({ requireAuthenticated: authenticated, resolveId: async () => base.id });

    const response = await app.request(`/by-base/${base.shortId}/assistant/context.md`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(contextRequested).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/markdown");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="context.md"');
    expect(body).toContain("Base: Assistant Base");
    expect(body).toContain("Use as: `from table Items`");
    expect(body).toContain("`Name`: text - Display name.");
    expect(body).not.toContain("Secret");
  });

  test("denies downloads without base read access", async () => {
    baseAccess = "none";
    const app = createGqlApi({ requireAuthenticated: authenticated, resolveId: async () => base.id });

    const response = await app.request(`/by-base/${base.shortId}/assistant/context.md`);

    expect(response.status).toBe(403);
    expect(contextRequested).toBe(false);
  });
});
