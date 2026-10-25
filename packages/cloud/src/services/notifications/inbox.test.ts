import { expect, test } from "bun:test";
import { NotificationInboxQuerySchema } from "../../contracts/notification-inbox";
import type { RequestAuthority } from "../../server/middleware/auth";
import type { ServiceAccount } from "../service-accounts";
import { buildProjectedUser } from "../session/user";
import { notificationInbox } from "./inbox";

const account: ServiceAccount = {
  id: "8d48fe49-50db-47cc-a47e-c5eb654b0fe7",
  name: "Agent",
  kind: "agent",
  status: "active",
  delegatedUserId: null,
  appId: null,
  resourceType: null,
  resourceId: null,
  createdBy: null,
  createdAt: "2026-10-23T00:00:00.000Z",
};
const authority = (changes: Partial<ServiceAccount> = {}, scopes = ["read"]): RequestAuthority => ({
  actor: { kind: "service_account", serviceAccount: { ...account, ...changes }, delegatedUser: null, scopes },
  accessSubject: { type: "service_account", serviceAccountId: account.id },
  credentialKind: "api_key",
  scopes,
});
const user = buildProjectedUser({ id: "09ac528f-4c0a-4468-bad1-d55cd29e4337", uid: "person", provider: "local", profile: "user" });

// These refusals must happen before any database access or decryption.
test("inbox rejects human, delegated and inconsistent authorities before reading content", async () => {
  const delegated = authority({ kind: "user_delegated", delegatedUserId: user.id });
  if (delegated.actor.kind !== "service_account") throw new Error("Expected service actor");
  delegated.actor.delegatedUser = user;
  const wrongSubject = authority();
  wrongSubject.accessSubject = { type: "service_account", serviceAccountId: user.id };
  const humanSubject = authority();
  humanSubject.accessSubject = { type: "user", userId: user.id };
  const invocation = authority();
  invocation.credentialKind = "invocation";
  for (const candidate of [
    { ...authority(), actor: { kind: "user" as const, user }, accessSubject: { type: "user" as const, userId: user.id } },
    delegated,
    wrongSubject,
    humanSubject,
    invocation,
    authority({ kind: "resource_bound", appId: "spaces", resourceType: "space" }),
    authority({ appId: "spaces" }),
    authority({ resourceType: "space" }),
    authority({ resourceId: "private" }),
    authority({ delegatedUserId: user.id }),
    authority({ status: "disabled" }),
  ]) {
    const result = await notificationInbox.list({ authority: candidate });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
  }
});

test("inbox caps both actor and request scopes and requires read for OAuth", async () => {
  for (const scopes of [[], ["write"], ["openid", "profile"], ["ai:inference"], ["identity:invoke"]]) {
    const result = await notificationInbox.list({ authority: authority({}, scopes) });
    expect(result.ok).toBe(false);
  }
  const requestCapped = authority();
  requestCapped.scopes = ["write"];
  const actorCapped = authority({}, ["write"]);
  actorCapped.scopes = ["read"];
  const oauth = authority({}, []);
  oauth.credentialKind = "oauth";
  for (const candidate of [requestCapped, actorCapped, oauth]) {
    const result = await notificationInbox.list({ authority: candidate });
    expect(result.ok).toBe(false);
  }
});

test("inbox pagination defaults and max100 are enforced at the service and HTTP seam", async () => {
  expect(NotificationInboxQuerySchema.parse({})).toEqual({ page: 1, perPage: 20 });
  expect(NotificationInboxQuerySchema.parse({ page: "2", perPage: "100" })).toEqual({ page: 2, perPage: 100 });
  for (const query of [
    { page: 0 },
    { page: 1.2 },
    { perPage: 0 },
    { perPage: 101 },
    { serviceAccountId: account.id },
    { page: Number.MAX_SAFE_INTEGER },
  ]) {
    expect(NotificationInboxQuerySchema.safeParse(query).success).toBe(false);
  }
  expect((await notificationInbox.list({ authority: authority(), perPage: 101 })).ok).toBe(false);
});

test("read/admin reaches validated pagination for API keys and OAuth", async () => {
  for (const credentialKind of ["api_key", "oauth"] as const) {
    for (const scopes of [["read"], ["admin"]]) {
      const candidate = authority({}, scopes);
      candidate.credentialKind = credentialKind;
      const result = await notificationInbox.list({ authority: candidate, perPage: 101 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.status).toBe(400);
    }
  }
});
