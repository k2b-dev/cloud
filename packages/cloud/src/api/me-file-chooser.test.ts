import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { FileChooserPlace } from "../contracts/file-chooser-place";
import type { User } from "../contracts/shared";
import type { AuthContext } from "../server";
import { createMeFileChooserRoutes } from "./me-file-chooser";

const user: User = {
  id: "22222222-2222-4222-8222-222222222222",
  uid: "chooser-test",
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

test("the file chooser place belongs to the signed-in person, is validated and bounded", async () => {
  const calls: string[] = [];
  let stored: FileChooserPlace | null = null;
  const service = {
    get: async (id: string) => {
      calls.push(id);
      return stored;
    },
    set: async (id: string, place: FileChooserPlace | null) => {
      calls.push(id);
      stored = place;
    },
  };
  const routes = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      c.set("user", user);
      await next();
    })
    .route("/", createMeFileChooserRoutes(service));
  const put = (body: unknown) =>
    routes.request("/file-chooser/place", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const empty = await routes.request("/file-chooser/place?userId=other");
  expect(empty.status).toBe(200);
  expect(empty.headers.get("cache-control")).toBe("no-store");
  expect(await empty.json()).toEqual({ place: null });
  const place = { appId: "filesv2", folders: [{ id: "n:base:1", name: "Scanner-Ablage" }] };
  expect((await put({ place })).status).toBe(204);
  expect(await (await routes.request("/file-chooser/place")).json()).toEqual({ place });
  expect((await put({ place: null })).status).toBe(204);
  expect(stored).toBeNull();
  expect((await put({ place: { ...place, userId: "other" } })).status).toBe(400);
  expect(
    (await put({ place: { appId: "filesv2", folders: Array.from({ length: 17 }, (_, i) => ({ id: `f${i}`, name: "x" })) } })).status,
  ).toBe(400);
  expect(calls).toEqual([user.id, user.id, user.id, user.id]);
  expect((await createMeFileChooserRoutes(service).request("/file-chooser/place")).status).toBe(401);
  expect((await put({ place, padding: "x".repeat(70_000) })).status).toBe(413);
});
