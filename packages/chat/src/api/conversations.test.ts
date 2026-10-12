import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { ServiceAccountCredentialSchema, ServiceAccountSchema, UserSchema } from "@k2b/cloud/contracts";
import * as platform from "@k2b/cloud/services";
import { redis } from "bun";
import { chatService } from "../service";
import chatApi from ".";

const userId = "11111111-1111-4111-8111-111111111111";
const account = ServiceAccountSchema.parse({
  id: "22222222-2222-4222-8222-222222222222",
  name: "API account",
  kind: "standalone",
  status: "active",
  delegatedUserId: null,
  appId: null,
  resourceType: null,
  resourceId: null,
  createdBy: null,
  createdAt: "2026-10-09T00:00:00Z",
});
const credential = ServiceAccountCredentialSchema.parse({
  id: "33333333-3333-4333-8333-333333333333",
  serviceAccountId: account.id,
  name: "API key",
  kind: "api_token",
  status: "active",
  tokenPrefix: "test",
  scopes: ["openid", "read"],
  expiresAt: null,
  createdAt: "2026-10-09T00:00:00Z",
  createdBy: null,
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
});
const person = UserSchema.parse({
  id: userId,
  uid: "lea",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Lea",
  sn: "Example",
  displayName: "Lea Example",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const authenticate = (delegated = false) =>
  spyOn(platform.serviceAccountCredentials, "authenticateApiToken").mockResolvedValue({
    credential,
    serviceAccount: delegated ? { ...account, kind: "user_delegated", delegatedUserId: userId } : account,
    delegatedUser: delegated ? person : null,
  });
const post = (path: string, body: unknown, locale = "en") =>
  chatApi.request(path, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json", "accept-language": locale },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  spyOn(platform, "get").mockResolvedValue(60);
  spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  spyOn(platform.serviceAccountCredentials, "isApiToken").mockReturnValue(true);
});
afterEach(() => mock.restore());

test("admits a service account to the service and returns the localized people-only error", async () => {
  authenticate();
  const response = await post("/conversations", {}, "de-DE");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ code: "BAD_INPUT", message: "Zurzeit können nur Personen Chat-Mitglieder sein." });
});
test("forwards the acting account, delegated subject, and request locale to member mutations", async () => {
  authenticate(true);
  const add = spyOn(chatService.conversations.members, "add").mockResolvedValue({ ok: true, data: { added: 1 } });
  const response = await post("/conversations/abcdef/members", { members: [userId] }, "de");
  expect(response.status).toBe(200);
  expect(add).toHaveBeenCalledWith(
    expect.objectContaining({
      conversationId: "abcdef",
      locale: "de",
      actor: expect.objectContaining({ kind: "service_account", delegatedUser: person }),
      accessSubject: { type: "user", userId },
      input: { members: [userId] },
    }),
  );
});
test("maps creation and duplicate outcomes to 201 and 200", async () => {
  authenticate(true);
  const create = spyOn(chatService.conversations, "create");
  create.mockResolvedValueOnce({ ok: true, data: { outcome: "existing", matches: [] } });
  expect((await post("/conversations", {})).status).toBe(200);
  create.mockResolvedValueOnce({
    ok: true,
    data: {
      outcome: "created",
      conversation: {
        id: "abcdef",
        name: null,
        icon: null,
        purpose: null,
        title: "You",
        memberCount: 1,
        rev: 1,
        permission: "admin",
        createdAt: "2026-10-09T00:00:00Z",
        lastActivityAt: "2026-10-09T00:00:00Z",
      },
    },
  });
  expect((await post("/conversations", {})).status).toBe(201);
});
test("returns the service's rate-limit error as 429", async () => {
  authenticate(true);
  spyOn(chatService.conversations, "create").mockResolvedValue({
    ok: false,
    code: "RATE_LIMITED",
    error: "Try again later.",
    status: 429,
  });
  const response = await post("/conversations", {});
  expect(response.status).toBe(429);
  expect(await response.json()).toEqual({ code: "RATE_LIMITED", message: "Try again later." });
});
test("localizes invalid inputs and rejects them before the service", async () => {
  authenticate(true);
  const create = spyOn(chatService.conversations, "create");
  const response = await post("/conversations", { members: Array(101).fill(userId) }, "de");
  expect(response.status).toBe(400);
  expect((await response.json()).message).toBe("Prüfe die Chat-Angaben, Mitglieds-IDs und Anfragegrenzen.");
  expect(create).not.toHaveBeenCalled();
});
test("requires authentication for all conversation routes", async () => {
  const get = spyOn(chatService.conversations, "get");
  const response = await chatApi.request("/conversations/abcdef");
  expect(response.status).toBe(401);
  expect(get).not.toHaveBeenCalled();
});

const textMessage = {
  id: "0123456789",
  conversationId: "abcdef",
  seq: 1,
  rev: 1,
  kind: "text" as const,
  author: { type: "user" as const, id: userId, name: "Lea Example" },
  body: " **Hello** ",
  system: null,
  createdAt: "2026-10-12T00:00:00.000Z",
  systemText: null,
};
test("message POST returns the shared view with 201 or 200 and forwards the delegated subject", async () => {
  authenticate(true);
  const send = spyOn(chatService.messages, "send");
  send.mockResolvedValueOnce({ ok: true, data: { message: textMessage, created: true } });
  const response = await post("/conversations/abcdef/messages", { clientId: "retry", body: textMessage.body }, "de");
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(textMessage);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({
      locale: "de",
      accessSubject: { type: "user", userId },
      input: { clientId: "retry", body: textMessage.body },
    }),
  );
  send.mockResolvedValueOnce({ ok: true, data: { message: textMessage, created: false } });
  expect((await post("/conversations/abcdef/messages", { clientId: "retry", body: "different" })).status).toBe(200);
});
test("message limits set the service's whole-second Retry-After header", async () => {
  authenticate(true);
  spyOn(chatService.messages, "send").mockResolvedValue({
    ok: false,
    error: "Try again later.",
    status: 429,
    code: "RATE_LIMITED",
    retryAfter: 4,
  });
  const response = await post("/conversations/abcdef/messages", { clientId: "limited", body: "Hello" });
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("4");
  expect(await response.json()).toEqual({ code: "RATE_LIMITED", message: "Try again later." });
});
test("rejects invalid message body and conflicting history cursors before the service", async () => {
  authenticate(true);
  const send = spyOn(chatService.messages, "send");
  const list = spyOn(chatService.messages, "list");
  expect((await post("/conversations/abcdef/messages", { clientId: "bad id", body: "Hello" })).status).toBe(400);
  const response = await chatApi.request("/conversations/abcdef/messages?before=1&after=2", {
    headers: { authorization: "Bearer test-key" },
  });
  expect(response.status).toBe(400);
  expect(send).not.toHaveBeenCalled();
  expect(list).not.toHaveBeenCalled();
});
