import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import * as platformServices from "@k2b/cloud/services";
import { oauthTokens } from "@k2b/cloud/services";
import { redis } from "bun";
import { hc } from "hono/client";
import { generateSpecs } from "hono-openapi";
import { collaboration, publicResources } from "../service";
import app, { type ApiType } from ".";

const base = "/mailboxes/{mailboxId}/conversations/completion";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "completion-route-test",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Completion",
  sn: "Mail",
  displayName: "Completion Route",
  mail: "completion-route@example.test",
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
} satisfies User;

afterEach(() => mock.restore());

describe("Mail batch conversation completion route", () => {
  beforeEach(() => {
    spyOn(platformServices, "get").mockResolvedValue(100);
    spyOn(redis, "send").mockImplementation(async (command) => {
      if (command !== "EVAL") throw new Error(`Unexpected Redis command: ${command}`);
      return [1, 0, "1"];
    });
  });
  test("publishes an authenticated completion operation with request and result schemas", async () => {
    const operation = (await generateSpecs(app)).paths?.[base]?.post;
    expect(operation?.summary).toBe("Mark conversations done or reopen them");
    expect(operation?.tags).toEqual(["Mail:Conversations"]);
    expect(operation?.security).toHaveLength(1);
    for (const status of ["200", "400", "401", "403", "404"]) expect(operation?.responses?.[status]).toBeDefined();
    expect(operation?.requestBody).toBeDefined();
    const response = operation?.responses?.["200"];
    expect(response && "$ref" in response ? undefined : response?.content?.["application/json"]?.schema).toMatchObject({
      type: "object",
      properties: { completion: { enum: ["done", "open"] }, results: { type: "array" } },
    });
  });
  test("requires authentication", async () => {
    const complete = spyOn(collaboration, "applyConversationCompletions");
    const response = await app.request("/mailboxes/mbx123/conversations/completion", { method: "POST" });
    expect(response.status).toBe(401);
    expect(complete).not.toHaveBeenCalled();
  });
  test("passes the internal mailbox id and public conversation ids through the typed client", async () => {
    const mailboxId = "22222222-2222-4222-8222-222222222222";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: ["read", "write"] });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(mailboxId);
    const conversationResolver = spyOn(publicResources, "resolveMailboxPublicId");
    const data = {
      completion: "done" as const,
      results: [
        { conversationId: "Convo1", status: "ok" as const, workStatus: "done" as const, revision: 2 },
        { conversationId: "Convo2", status: "not_found" as const },
      ],
    };
    const complete = spyOn(collaboration, "applyConversationCompletions").mockResolvedValue({ ok: true, data });
    const client = hc<ApiType>("http://localhost", {
      fetch: (request: RequestInfo | URL, init?: RequestInit) => app.request(request instanceof URL ? request.href : request, init),
    });
    const response = await client.mailboxes[":mailboxId"].conversations.completion.$post(
      {
        param: { mailboxId: "mbx123" },
        json: { conversationIds: ["Convo1", "Convo2"], completion: "done" },
      },
      { headers: { authorization: "Bearer completion-test" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(data);
    expect(complete).toHaveBeenCalledWith({
      context: expect.anything(),
      mailboxId,
      conversationIds: ["Convo1", "Convo2"],
      completion: "done",
    });
    expect(conversationResolver).not.toHaveBeenCalled();
  });
  test("rejects empty, oversized, duplicate, unknown and non-strict inputs before calling the service", async () => {
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: ["read", "write"] });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue("22222222-2222-4222-8222-222222222222");
    const complete = spyOn(collaboration, "applyConversationCompletions");
    for (const input of [
      { conversationIds: [], completion: "done" },
      { conversationIds: Array.from({ length: 51 }, (_, i) => `Cv${String(i).padStart(4, "0")}`), completion: "done" },
      { conversationIds: ["Convo1", "Convo1"], completion: "done" },
      { conversationIds: ["Convo1"], completion: "waiting" },
      { conversationIds: ["Convo1"], completion: "done", extra: true },
    ]) {
      const response = await app.request("/mailboxes/mbx123/conversations/completion", {
        method: "POST",
        headers: { authorization: "Bearer completion-test", "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
    }
    expect(complete).not.toHaveBeenCalled();
  });
});
