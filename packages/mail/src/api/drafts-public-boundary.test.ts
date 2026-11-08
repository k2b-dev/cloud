import { afterEach, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { oauthTokens } from "@k2b/cloud/services";
import { err, fail, ok } from "@k2b/stdlib";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import { commands, drafts, mailboxAccess, publicResources } from "../service";
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

// These API contracts exercise the real services behind the routes, so they need the test database.
const suite = databaseSuite();

suite("Mail draft public boundary", () => {
  test("resolves public route IDs once before listing conversation drafts", async () => {
    const mailboxId = "22222222-2222-4222-8222-222222222222";
    const conversationId = "33333333-3333-4333-8333-333333333333";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: ["read", "write"] });
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue(ok("admin"));
    spyOn(mailboxAccess, "getMailboxPermission").mockResolvedValue("admin");
    spyOn(publicResources, "publicIds").mockImplementation(
      async (_table, ids) => new Map(ids.flatMap((id) => (typeof id === "string" ? [[id, id] as const] : []))),
    );
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(mailboxId);
    spyOn(mailboxAccess, "requireMailboxAccess").mockResolvedValue(ok({ scope: "mailbox", permission: "admin" }));
    spyOn(publicResources, "resolveMailboxPublicId").mockResolvedValue(conversationId);
    const listConversationDrafts = spyOn(drafts, "listConversationDrafts").mockResolvedValue(ok([]));

    const response = await app.request("/mailboxes/mbx123/conversations/cnv123/drafts?limit=20", {
      headers: { authorization: "Bearer draft-boundary-test", "x-forwarded-for": uniqueCallerAddress() },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(listConversationDrafts).toHaveBeenCalledWith(expect.objectContaining({ mailboxId, conversationId, limit: 20 }));
  });
});

suite("Mail command public boundary", () => {
  test("resolves resource inputs to UUIDs and projects command targets back to short IDs", async () => {
    const mailboxId = "22222222-2222-4222-8222-222222222222";
    const messageId = "33333333-3333-4333-8333-333333333333";
    const folderId = "44444444-4444-4444-8444-444444444444";
    const commandId = "55555555-5555-4555-8555-555555555555";
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: ["read", "write"] });
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue(ok("admin"));
    spyOn(mailboxAccess, "getMailboxPermission").mockResolvedValue("admin");
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(mailboxId);
    spyOn(mailboxAccess, "requireMailboxAccess").mockResolvedValue(ok({ scope: "mailbox", permission: "admin" }));
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
      headers: {
        authorization: "Bearer command-boundary-test",
        "x-forwarded-for": uniqueCallerAddress(),
        "content-type": "application/json",
      },
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

suite("Mail draft seed public boundary", () => {
  const mailboxId = "22222222-2222-4222-8222-222222222222";
  const messageId = "33333333-3333-4333-8333-333333333333";
  const senderIdentityId = "44444444-4444-4444-8444-444444444444";
  const seedId = "55555555-5555-4555-8555-555555555555";
  const publicIds: Record<string, string> = { [mailboxId]: "mbx123", [messageId]: "msg123", [senderIdentityId]: "snd123" };
  const internalIds: Record<string, string> = { msg123: messageId, snd123: senderIdentityId };
  const publicOrigin = {
    kind: "derive",
    messageId: "msg123",
    input: { kind: "edit_as_new", senderIdentityId: "snd123", includeAttachments: true },
  } as const;
  const internalOrigin = { ...publicOrigin, messageId, input: { ...publicOrigin.input, senderIdentityId } };

  const stubBoundary = () => {
    spyOn(mailboxAccess, "requireMailboxAccess").mockResolvedValue(ok({ scope: "mailbox", permission: "admin" }));
    spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", payload: {}, user, scopes: ["read", "write"] });
    spyOn(mailboxAccess, "requireMailboxPermission").mockResolvedValue(ok("admin"));
    spyOn(mailboxAccess, "getMailboxPermission").mockResolvedValue("admin");
    spyOn(publicResources, "resolvePublicId").mockResolvedValue(mailboxId);
    spyOn(publicResources, "resolveMailboxPublicId").mockImplementation(async (_table, _mailbox, id) => internalIds[id] ?? null);
    spyOn(publicResources, "resolveMailboxPublicIds").mockImplementation(async (_table, _mailbox, ids) => {
      const resolved = ids.flatMap((id) => (internalIds[id] ? [internalIds[id]] : []));
      return resolved.length === ids.length ? resolved : null;
    });
    spyOn(publicResources, "publicIds").mockImplementation(
      async (table, ids) =>
        new Map(ids.flatMap((id) => (typeof id === "string" ? ([[id, publicIds[id] ?? `${table}-missing`]] as const) : []))),
    );
  };
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer draft-seed-boundary-test",
        "x-forwarded-for": uniqueCallerAddress(),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

  // "Use as new message" sent the public message ID through to the service, which answered "Invalid UUID".
  test("resolves the derived message to its UUID and returns the origin with public IDs", async () => {
    stubBoundary();
    const prepareDraftSeed = spyOn(drafts, "prepareDraftSeed").mockResolvedValue(
      ok({
        id: seedId,
        mailboxId,
        conversationId: null,
        intent: "new",
        sourceMessageId: null,
        derivedFromMessageId: messageId,
        derivationKind: "edit_as_new",
        content: {
          senderIdentityId,
          to: [],
          cc: [],
          bcc: [],
          subject: "Again",
          body: "",
          format: "markdown",
          priority: "normal",
          requestDeliveryReceipt: false,
          requestReadReceipt: false,
        },
        attachments: [],
        origin: internalOrigin,
        createdAt: "2026-11-02T09:00:00.000Z",
      }),
    );

    const response = await post("/mailboxes/mbx123/draft-seeds", { origin: publicOrigin });

    expect(response.status).toBe(200);
    expect(prepareDraftSeed).toHaveBeenCalledWith(expect.objectContaining({ mailboxId, origin: internalOrigin }));
    expect(await response.json()).toMatchObject({ mailboxId: "mbx123", derivedFromMessageId: "msg123", origin: publicOrigin });
  });

  test("resolves the derived message when the composer saves the seed", async () => {
    stubBoundary();
    const materializeDraftSeed = spyOn(drafts, "materializeDraftSeed").mockResolvedValue(fail(err.conflict("stop after the boundary")));

    await post("/mailboxes/mbx123/draft-seeds/materialize", {
      idempotencyKey: seedId,
      origin: publicOrigin,
      draft: { senderIdentityId: "snd123", to: [], cc: [], bcc: [], subject: "Again", body: "" },
    });

    expect(materializeDraftSeed).toHaveBeenCalledWith(
      expect.objectContaining({
        mailboxId,
        input: expect.objectContaining({ origin: internalOrigin, draft: expect.objectContaining({ senderIdentityId }) }),
      }),
    );
  });
});
