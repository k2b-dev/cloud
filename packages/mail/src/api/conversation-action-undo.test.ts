import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import * as platformServices from "@k2b/cloud/services";
import { oauthTokens } from "@k2b/cloud/services";
import { redis } from "bun";
import { hc } from "hono/client";
import { generateSpecs } from "hono-openapi";
import { MAX_CONVERSATION_ACTION_MESSAGES } from "../contracts";
import { publicResources, triage } from "../service";
import app, { type ApiType } from ".";

const base = "/mailboxes/{mailboxId}/conversations/{conversationId}";
const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "undo-route-test",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Undo",
  sn: "Mail",
  displayName: "Undo Route",
  mail: "undo-route@example.test",
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

describe("Mail conversation action undo route", () => {
  beforeEach(() => {
    spyOn(platformServices, "get").mockResolvedValue(100);
    spyOn(redis, "send").mockImplementation(async (command) => {
      if (command !== "EVAL") throw new Error(`Unexpected Redis command: ${command}`);
      return [1, 0, "1"];
    });
  });

  test("publishes the authenticated undo operation and its outcome schema", async () => {
    const spec = await generateSpecs(app);
    const operation = spec.paths?.[`${base}/actions/undo`]?.post;
    expect(operation?.summary).toBe("Undo the provider commands of a conversation action");
    expect(operation?.tags).toEqual(["Mail:Commands"]);
    expect(operation?.security).toHaveLength(1);
    for (const status of ["200", "400", "403", "404"]) expect(operation?.responses?.[status]).toBeDefined();
    expect(operation?.requestBody).toBeDefined();
    const response = operation?.responses?.["200"];
    expect(response && "$ref" in response ? undefined : response?.content?.["application/json"]?.schema).toMatchObject({
      type: "object",
      properties: {
        commands: {
          type: "array",
          items: {
            properties: {
              id: { type: "string", format: "uuid" },
              outcome: { enum: ["cancelled", "reversed", "pending", "not_applied", "unavailable"] },
            },
          },
        },
      },
    });
  });

  test("requires authentication before undoing a conversation action", async () => {
    const undo = spyOn(triage, "undoConversationTriageCommands");
    const response = await app.request("/mailboxes/mbx123/conversations/cnv123/actions/undo", { method: "POST" });
    expect(response.status).toBe(401);
    expect(undo).not.toHaveBeenCalled();
  });

  test("resolves resource IDs while preserving command UUIDs through the typed client", async () => {
    const mailboxId = "22222222-2222-4222-8222-222222222222";
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const commandId = "44444444-4444-4444-8444-444444444444";
    const inverseId = "55555555-5555-4555-8555-555555555555";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(mailboxId);
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(conversationId);
    const project = spyOn(publicResources, "publicIds");
    const data = {
      commands: [{ id: commandId, outcome: "reversed" as const, inverse: { id: inverseId, state: "queued" as const, code: null } }],
    };
    const undo = spyOn(triage, "undoConversationTriageCommands").mockResolvedValue({ ok: true, data });
    const client = hc<ApiType>("http://localhost", {
      fetch: (request: RequestInfo | URL, init?: RequestInit) => app.request(request instanceof URL ? request.href : request, init),
    });
    const response = await client.mailboxes[":mailboxId"].conversations[":conversationId"].actions.undo.$post(
      {
        param: { mailboxId: "mbx123", conversationId: "cnv123" },
        json: { commandIds: [commandId] },
      },
      { headers: { authorization: "Bearer undo-route-test" } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(data);
    expect(undo).toHaveBeenCalledWith({ context: expect.anything(), mailboxId, conversationId, input: { commandIds: [commandId] } });
    expect(project).not.toHaveBeenCalled();
  });

  test("rejects malformed, oversized and non-strict undo inputs before calling the service", async () => {
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue("22222222-2222-4222-8222-222222222222");
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue("33333333-3333-4333-8333-333333333333");
    const undo = spyOn(triage, "undoConversationTriageCommands");
    const id = "44444444-4444-4444-8444-444444444444";
    for (const input of [
      { commandIds: [] },
      { commandIds: ["cmd123"] },
      { commandIds: Array(MAX_CONVERSATION_ACTION_MESSAGES + 1).fill(id) },
      { commandIds: [id], extra: true },
    ]) {
      const response = await app.request("/mailboxes/mbx123/conversations/cnv123/actions/undo", {
        method: "POST",
        headers: { authorization: "Bearer undo-route-test", "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
    }
    expect(undo).not.toHaveBeenCalled();
  });
});
