import { expect, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import "./_components/ssr-test-plugin";

const person = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "reader",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Test",
  sn: "Reader",
  displayName: "Test Reader",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

const { contactsFavoritesHintOpen } = await import("./contacts-hints");
const app = new Hono<AuthContext>()
  .use("*", async (c, next) => {
    c.set("actor", { kind: "user", user: person });
    await next();
  })
  .get("/", (c) => c.json({ open: contactsFavoritesHintOpen(c, c.req.query("noBooks") ? 0 : 1) }));

test("opens only for readable books and honors dismissal after reload", async () => {
  expect(await (await app.request("/")).json()).toEqual({ open: true });
  expect(await (await app.request("/?noBooks=1")).json()).toEqual({ open: false });
  expect(await (await app.request("/", { headers: { Cookie: "cloud_seen_hints=contacts.favorites-tab" } })).json()).toEqual({
    open: false,
  });
});

test("visiting favorites marks seen before deciding and persists the cookie", async () => {
  const response = await app.request("/?favorites=true");
  expect(await response.json()).toEqual({ open: false });
  const cookie = response.headers.get("set-cookie")!;
  expect(cookie).toContain("contacts.favorites-tab");
  expect(await (await app.request("/", { headers: { Cookie: cookie.split(";")[0]! } })).json()).toEqual({ open: false });
  expect(await (await app.request("/?favorites=false")).json()).toEqual({ open: true });
});
