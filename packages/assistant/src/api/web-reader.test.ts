import { afterEach, expect, spyOn, test } from "bun:test";
import { redis } from "@k2b/cloud";
import * as ai from "@k2b/cloud/ai";
import { oauthTokens } from "@k2b/cloud/services";
import * as settings from "@k2b/cloud/services/settings";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { testIdentity } from "../chat-code/test-identity";
import api from ".";

useUnitClients();
const identity = testIdentity("11111111-1111-4111-8111-111111111111");
const at = "2026-11-14T12:00:00.000Z";
const conversation: ai.AiConversation = {
  id: "22222222-2222-4222-8222-222222222222",
  shortId: "Cht234",
  title: "Chat",
  titleSource: "user",
  description: "",
  descriptionSource: "default",
  keywords: [],
  pinnedAt: null,
  archivedAt: null,
  done: null,
  isDone: false,
  lastUsedAt: at,
  runStatus: "idle",
  runError: null,
  unreadCompletion: false,
  projectId: null,
  draft: { content: [], updatedAt: null, revision: 0 },
  createdByUserId: identity.user.id,
  createdAt: at,
  updatedAt: at,
};
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});
function setup() {
  spies.push(spyOn(settings, "get").mockResolvedValue(100));
  spies.push(spyOn(redis, "send").mockResolvedValue([0, 0, "0"]));
  const verify = spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({
    kind: "user",
    user: identity.user,
    payload: {},
    scopes: ["read"],
  });
  spies.push(verify);
  const chat = spyOn(ai.aiConversations, "getConversationByShortId").mockResolvedValue(conversation);
  const read = spyOn(ai, "readWebPageForPerson").mockResolvedValue({ status: "confirm", url: "https://example.com/page" });
  const configured = spyOn(ai, "isCloudAiFirecrawlConfigured").mockResolvedValue(true);
  spies.push(chat, read, configured);
  return { chat, read, configured, verify };
}
const headers = { authorization: "Bearer web-reader-test-token", "content-type": "application/json" };
const request = (body: unknown = { url: "https://example.com/page" }) =>
  api.request(`/workspace/conversations/${conversation.shortId}/web-reader`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

test("availability GET is authenticated and does not load a chat or fetch a page", async () => {
  const { configured, chat, read } = setup();
  expect((await api.request("/workspace/web-reader")).status).toBe(401);
  expect(await (await api.request("/workspace/web-reader", { headers })).json()).toEqual({ available: true });
  configured.mockResolvedValue(false);
  expect(await (await api.request("/workspace/web-reader", { headers })).json()).toEqual({ available: false });
  expect(chat).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

test("read-only POST resolves the person's chat before passing its internal ID and exact request to the platform", async () => {
  const { chat, read } = setup();
  const response = await request({ url: "https://example.com/page?exact=1", confirmed: true });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "confirm", url: "https://example.com/page" });
  expect(chat).toHaveBeenCalledWith({ shortId: conversation.shortId, ownerUserId: identity.user.id });
  expect(read).toHaveBeenCalledWith({
    actor: identity.actor,
    conversationId: conversation.id,
    url: "https://example.com/page?exact=1",
    confirmed: true,
    signal: expect.any(AbortSignal),
  });
});

test("a missing or someone else's chat returns 404 and never reaches the reader", async () => {
  const { chat, read } = setup();
  chat.mockResolvedValue(null);
  expect((await request()).status).toBe(404);
  expect(read).not.toHaveBeenCalled();
});

test("a standalone service account cannot read pages or query availability", async () => {
  const { verify, read, configured, chat } = setup();
  verify.mockResolvedValue({
    kind: "service_account",
    payload: {},
    scopes: ["read"],
    delegatedUser: null,
    oauthClientId: "test-client",
    serviceAccount: {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Service",
      kind: "standalone",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: at,
    },
  });
  expect((await request()).status).toBe(403);
  expect((await api.request("/workspace/web-reader", { headers })).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
  expect(configured).not.toHaveBeenCalled();
  expect(chat).not.toHaveBeenCalled();
});

test("validates the address limit and confirmation type before reading", async () => {
  const { read } = setup();
  for (const body of [{ url: "x".repeat(2049) }, { url: "https://example.org", confirmed: "true" }, { confirmed: true }])
    expect((await request(body)).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
});
