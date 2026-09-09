import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { commands, drafts, publicResources } from "../service";
import app from ".";

const user = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "draft-boundary-test",
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Draft",
  sn: "Boundary",
  displayName: "Draft Boundary",
  mail: "draft-boundary@example.test",
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

describe("Mail draft public boundary", () => {
  test("resolves public route IDs once before listing conversation drafts", async () => {
    const mailboxId = "22222222-2222-4222-8222-222222222222";
    const conversationId = "33333333-3333-4333-8333-333333333333";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(mailboxId);
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(conversationId);
    const listConversationDrafts = spyOn(drafts, "listConversationDrafts").mockResolvedValue(ok([]));

    const response = await app.request("/mailboxes/mbx123/conversations/cnv123/drafts?limit=20", {
      headers: { authorization: "Bearer draft-boundary-test" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(listConversationDrafts).toHaveBeenCalledWith(expect.objectContaining({ mailboxId, conversationId, limit: 20 }));
  });
});

describe("Mail command public boundary", () => {
  test("resolves resource inputs to UUIDs and projects command targets back to short IDs", async () => {
    const mailboxId = "22222222-2222-4222-8222-222222222222";
    const messageId = "33333333-3333-4333-8333-333333333333";
    const folderId = "44444444-4444-4444-8444-444444444444";
    const commandId = "55555555-5555-4555-8555-555555555555";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: [] });
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(mailboxId);
    spyOn(publicResources, "resolveMailboxPublicIds").mockResolvedValue([folderId]);
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(messageId);
    spyOn(publicResources, "publicIds").mockImplementation(async (table, ids) => {
      const values: Record<string, string> = {
        [mailboxId]: "mbx123",
        [messageId]: "msg123",
        [folderId]: "fld123",
      };
      return new Map(ids.flatMap((id) => (typeof id === "string" ? ([[id, values[id] ?? `${table}-missing`]] as const) : [])));
    });
    const createMailCommand = spyOn(commands, "createMailCommand").mockResolvedValue(
      ok({
        id: commandId,
        mailboxId,
        kind: "change_message_state",
        state: "queued",
        actor: { kind: "user", userId: user.id },
        idempotencyKey: "command-boundary-test",
        correlationId: null,
        target: { messageId, folderId },
        payload: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
        selectedBindingId: null,
        rightsSnapshot: null,
        transportMetadata: {},
        result: {},
        attempt: 0,
        lastError: null,
        createdAt: "2026-08-12T18:00:00.000Z",
        updatedAt: "2026-08-12T18:00:00.000Z",
      }),
    );

    const response = await app.request("/mailboxes/mbx123/commands", {
      method: "POST",
      headers: { authorization: "Bearer command-boundary-test", "content-type": "application/json" },
      body: JSON.stringify({
        kind: "change_message_state",
        messageId: "msg123",
        folderId: "fld123",
        change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
        idempotencyKey: "command-boundary-test",
      }),
    });

    expect(response.status).toBe(200);
    expect(createMailCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        mailboxId,
        input: expect.objectContaining({ messageId, folderId }),
      }),
    );
    expect(await response.json()).toMatchObject({
      id: commandId,
      mailboxId: "mbx123",
      target: { messageId: "msg123", folderId: "fld123" },
    });
  });
});
