import { expect, test } from "bun:test";
import { ServiceAccountSchema } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { chatRequestContext } from "./request-context";
import { discussionRead } from "./service/discussion-read";

test("SSR service reads share one request budget while separate requests start fresh", async () => {
  const account = ServiceAccountSchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Reader",
    kind: "standalone",
    status: "active",
    delegatedUserId: null,
    appId: null,
    resourceType: null,
    resourceId: null,
    createdBy: null,
    createdAt: "2026-10-29T12:00:00Z",
  });
  const app = new Hono<AuthContext>().get("/", async (c) => {
    c.set("actor", { kind: "service_account", serviceAccount: account, scopes: ["read"], delegatedUser: null });
    c.set("accessSubject", { type: "service_account", serviceAccountId: account.id });
    c.set("credentialScopes", ["read"]);
    const first = discussionRead(chatRequestContext(c));
    expect(first.remaining).toBe(60);
    await first.page(async () => null);
    const next = discussionRead(chatRequestContext(c));
    expect(next.remaining).toBe(59);
    return c.json({ remaining: next.remaining });
  });
  expect(await (await app.request("http://chat.test/")).json()).toEqual({ remaining: 59 });
  expect(await (await app.request("http://chat.test/")).json()).toEqual({ remaining: 59 });
});
