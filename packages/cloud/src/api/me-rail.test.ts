import { expect, test } from "bun:test";
import { Hono } from "hono";
import { defaultRailPreferences, type RailPreferences } from "../contracts/rail-preferences";
import type { User } from "../contracts/shared";
import type { AuthContext } from "../server";
import { createMeRailRoutes } from "./me-rail";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "rail-test",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "",
  sn: "",
  displayName: "",
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

test("rail API derives ownership from authentication, validates input and reports conflicts", async () => {
  const calls: string[] = [];
  let stored = defaultRailPreferences();
  const service = {
    get: async (id: string) => {
      calls.push(id);
      return stored;
    },
    save: async (id: string, value: RailPreferences) => {
      calls.push(id);
      if (value.revision !== stored.revision) return null;
      stored = { ...value, revision: value.revision + 1 };
      return stored;
    },
  };
  const routes = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("user", user);
      await next();
    })
    .route("/", createMeRailRoutes(service));
  const put = (body: unknown) =>
    routes.request("/rail", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const initial = await routes.request("/rail?userId=other");
  expect(initial.status).toBe(200);
  expect(initial.headers.get("cache-control")).toBe("no-store");
  expect((await put({ ...stored, visibility: { mail: false } })).status).toBe(200);
  expect((await put(defaultRailPreferences())).status).toBe(409);
  expect((await put({ ...stored, userId: "other" })).status).toBe(400);
  expect(calls).toEqual([user.id, user.id, user.id]);
  expect((await createMeRailRoutes(service).request("/rail")).status).toBe(401);
  expect((await put({ padding: "x".repeat(17000) })).status).toBe(413);
});
