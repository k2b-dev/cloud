import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { drafts, publicResources } from "../service";
import { imapSmtpConnector, transportDiagnostic } from "../service/connectors/imap-smtp";
import { mailboxLogoFailure } from "../service/mailbox-logo-errors";
import { verifyProviderConnection } from "../service/provider-connections";
import {
  internalDraftSeedInput,
  type MailApiContext,
  projectDraftSeed,
  projectPublicRelations,
  projectPublicResult,
  projectResourcePaths,
  resolvePublicRelations,
  respondPublic,
} from "./public-resource-boundary";

afterEach(() => mock.restore());

describe("Mail public response projection", () => {
  test("maps signature relations in draft and seed content in both directions", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const resolve = spyOn(publicResources, "resolveMailboxPublicIds").mockResolvedValue([id]);
    const project = spyOn(publicResources, "publicIds").mockResolvedValue(new Map([[id, "Sign01"]]));
    const request = { draft: { signatureTemplateId: "Sign01" }, seed: { content: { signatureTemplateId: "Sign01" } } };
    const internal = { draft: { signatureTemplateId: id }, seed: { content: { signatureTemplateId: id } } };
    expect(await resolvePublicRelations("mailbox", request)).toEqual(internal);
    expect(resolve).toHaveBeenCalledWith("composeTemplates", "mailbox", ["Sign01"]);
    expect(await projectPublicRelations(internal)).toEqual(request);
    expect(project).toHaveBeenCalledWith("composeTemplates", [id]);
  });

  test("localizes final API errors from the request locale", async () => {
    const app = new Hono<MailApiContext>().get("/", (c) => respondPublic(c, fail(err.notFound("Mailbox"))));
    const response = await app.request("/", { headers: { "Accept-Language": "de-CH,de;q=0.9" } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      message: "Das Postfach wurde nicht gefunden",
    });
  });

  test("preserves logo validation details through projection for localized public responses", async () => {
    const failure = fail(mailboxLogoFailure("tooManyPixels", { width: 2000, height: 500 }));
    expect(await projectPublicResult(failure)).toBe(failure);
    const app = new Hono<MailApiContext>().get("/", (c) => respondPublic(c, failure));
    for (const [locale, message] of [
      ["en", "The logo is 2000x500 pixels; the maximum is 1200x400 pixels"],
      ["de-CH", "Das Logo hat 2000×500 Pixel; erlaubt sind höchstens 1200×400 Pixel."],
    ] as const) {
      const response = await app.request("/", { headers: { "Accept-Language": locale } });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ code: "BAD_INPUT", message });
    }
  });

  test("shows the provider's login failure detail with a German invalid-input error", async () => {
    const password = "correct horse battery staple";
    const imapFailure = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      serverResponseCode: "AUTHENTICATIONFAILED",
      responseText: `Invalid credentials for ${password} (Failure)`,
    });
    spyOn(imapSmtpConnector, "verify").mockRejectedValue(
      Object.assign(new Error("IMAP: Authentication failed; SMTP: Verified"), {
        code: "PROVIDER_TRANSPORT_VERIFICATION_FAILED",
        diagnostics: {
          imap: transportDiagnostic({ status: "rejected", reason: imapFailure }, [password]),
          smtp: transportDiagnostic({ status: "fulfilled", value: null }),
        },
      }),
    );
    const endpoint = { host: "mail.example.org", port: 993, tlsMode: "implicit" as const };
    const app = new Hono<MailApiContext>().post("/", (c) =>
      respondPublic(
        c,
        verifyProviderConnection({
          name: "Team",
          email: "team@example.org",
          username: "team@example.org",
          imap: endpoint,
          smtp: { ...endpoint, port: 465 },
          secret: { kind: "password", password },
        }),
      ),
    );

    const response = await app.request("/", { method: "POST", headers: { "Accept-Language": "de-DE" } });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "BAD_INPUT",
      message:
        "Die Eingabe ist ungültig: IMAP: Authentication failed: AUTHENTICATIONFAILED Invalid credentials for [redacted] (Failure); SMTP: Verified",
    });
  });

  test("resolves nested search folder IDs inside the mailbox and rejects unknown folders", async () => {
    const internalFolderId = "00000000-0000-4000-8000-000000000001";
    const resolve = spyOn(publicResources, "resolveMailboxPublicIds").mockImplementation(async (_table, _mailboxId, values) =>
      values.every((value) => value === "Fold01") ? values.map(() => internalFolderId) : null,
    );
    const request = (folderId: string) => ({
      expression: { type: "not", expression: { type: "folder_id", folderId } },
    });

    expect(await resolvePublicRelations("mailbox-internal", request("Fold01"))).toEqual(request(internalFolderId));
    expect(resolve).toHaveBeenCalledWith("folders", "mailbox-internal", ["Fold01"]);
    expect(await resolvePublicRelations("mailbox-internal", request("HM3ntB"))).toBeNull();
  });

  test("preserves already-public resource IDs", async () => {
    const value = { mailboxId: "aB3dE6", conversationId: "fG7hI8" };
    expect(await projectPublicRelations(value)).toEqual(value);
  });

  test("preserves an already-public root and nested attachment ID", async () => {
    const value = { id: "Ab12Cd", attachments: [{ id: "Ef34Gh" }] };
    expect(await projectPublicResult(ok(value), "messages")).toEqual(ok(value));
  });

  test("does not confuse an RFC Message-ID with a Mail resource ID", async () => {
    const value = { messageId: "<message-42@example.test>", subject: "Hello" };
    expect(await projectPublicRelations(value)).toEqual(value);
  });

  test("projects search resource IDs without touching the RFC Message-ID", async () => {
    const messageId = "11111111-1111-4111-8111-111111111111";
    const conversationId = "22222222-2222-4222-8222-222222222222";
    const folderId = "33333333-3333-4333-8333-333333333333";
    const publicIds = new Map([
      [messageId, "msg123"],
      [conversationId, "cnv123"],
      [folderId, "fld123"],
    ]);
    spyOn(publicResources, "publicIds").mockImplementation(
      async (_table, ids) => new Map(ids.filter((id): id is string => typeof id === "string").map((id) => [id, publicIds.get(id)!])),
    );

    const projected = await projectPublicResult(
      ok({
        items: [
          {
            id: messageId,
            conversationId,
            messageId: "<message-42@example.test>",
            activeFolderIds: [folderId],
            unreadFolderIds: [folderId],
            flaggedFolderIds: [folderId],
          },
        ],
      }),
      "messages",
    );

    expect(projected).toEqual(
      ok({
        items: [
          {
            id: "msg123",
            conversationId: "cnv123",
            messageId: "<message-42@example.test>",
            activeFolderIds: ["fld123"],
            unreadFolderIds: ["fld123"],
            flaggedFolderIds: ["fld123"],
          },
        ],
      }),
    );
  });

  test("projects queued send result IDs for browser navigation", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const messageId = "22222222-2222-4222-8222-222222222222";
    const deliveryId = "33333333-3333-4333-8333-333333333333";
    spyOn(publicResources, "publicIds").mockImplementation(async (table) =>
      table === "conversations"
        ? new Map([[conversationId, "cnv123"]])
        : table === "messages"
          ? new Map([[messageId, "msg123"]])
          : new Map([[deliveryId, "dlv123"]]),
    );

    expect(
      await projectPublicRelations({ result: { conversationId, outboundMessageId: messageId, outboxSubmissionId: deliveryId } }),
    ).toEqual({
      result: { conversationId: "cnv123", outboundMessageId: "msg123", outboxSubmissionId: "dlv123" },
    });
  });

  test("projects only explicitly selected nested mutation IDs", async () => {
    const sourceId = "11111111-1111-4111-8111-111111111111";
    const targetId = "22222222-2222-4222-8222-222222222222";
    spyOn(publicResources, "publicIds").mockResolvedValue(
      new Map([
        [sourceId, "src123"],
        [targetId, "tgt123"],
      ]),
    );

    const projected = await projectResourcePaths(ok({ source: { id: sourceId }, target: { id: targetId }, technicalId: sourceId }), [
      { path: ["source", "id"], table: "conversations" },
      { path: ["target", "id"], table: "conversations" },
    ]);

    expect(projected).toEqual(ok({ source: { id: "src123" }, target: { id: "tgt123" }, technicalId: sourceId }));
  });

  test("projects explicit workspace selection scalars", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const messageId = "22222222-2222-4222-8222-222222222222";
    spyOn(publicResources, "publicIds").mockImplementation(async (table) =>
      table === "conversations" ? new Map([[conversationId, "cnv123"]]) : new Map([[messageId, "msg123"]]),
    );

    const projected = await projectResourcePaths(ok({ selectedConversationId: conversationId, selectedMessageId: messageId }), [
      { path: ["selectedConversationId"], table: "conversations" },
      { path: ["selectedMessageId"], table: "messages" },
    ]);

    expect(projected).toEqual(ok({ selectedConversationId: "cnv123", selectedMessageId: "msg123" }));
  });

  test("batches independent resource-table projections concurrently", async () => {
    const conversationId = "11111111-1111-4111-8111-111111111111";
    const messageId = "22222222-2222-4222-8222-222222222222";
    let active = 0;
    let maximumActive = 0;
    spyOn(publicResources, "publicIds").mockImplementation(async (table) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return table === "conversations" ? new Map([[conversationId, "cnv123"]]) : new Map([[messageId, "msg123"]]);
    });

    const projected = await projectResourcePaths(ok({ conversationId, messageId }), [
      { path: ["conversationId"], table: "conversations" },
      { path: ["messageId"], table: "messages" },
    ]);

    expect(maximumActive).toBe(2);
    expect(projected).toEqual(ok({ conversationId: "cnv123", messageId: "msg123" }));
  });
});

// "Use as new message" sent the public message ID through to the service, which answered "Invalid UUID".
describe("Mail draft seed derive origin", () => {
  const mailboxId = "00000000-0000-4000-8000-000000000010";
  const messageId = "00000000-0000-4000-8000-000000000011";
  const senderIdentityId = "00000000-0000-4000-8000-000000000012";
  const publicOrigin = {
    kind: "derive",
    messageId: "Msg001",
    input: { kind: "edit_as_new", senderIdentityId: "Send01", includeAttachments: true },
  } as const;
  const internalOrigin = { ...publicOrigin, messageId, input: { ...publicOrigin.input, senderIdentityId } };
  const internalIds: Record<string, string> = { Msg001: messageId, Send01: senderIdentityId };
  const user = {
    id: "00000000-0000-4000-8000-000000000013",
    uid: "seed-boundary-test",
    roles: ["user"],
    provider: "local",
    profile: "user",
    givenname: "Seed",
    sn: "Boundary",
    displayName: "Seed Boundary",
    mail: "seed-boundary@example.test",
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  } satisfies User;
  const resolveApp = () =>
    new Hono<MailApiContext>()
      .use((c, next) => {
        c.set("internalMailboxId", mailboxId);
        return next();
      })
      .post("/", async (c) => c.json(await internalDraftSeedInput(c, await c.req.json<{ origin: typeof publicOrigin }>())));
  const stubResolution = () => {
    const message = spyOn(publicResources, "resolveMailboxPublicId").mockImplementation(
      async (_table, _mailbox, id) => internalIds[id] ?? null,
    );
    spyOn(publicResources, "resolveMailboxPublicIds").mockImplementation(async (_table, _mailbox, ids) => {
      const resolved = ids.flatMap((id) => (internalIds[id] ? [internalIds[id]] : []));
      return resolved.length === ids.length ? resolved : null;
    });
    return message;
  };

  test("resolves the derived message and sender to internal IDs", async () => {
    const message = stubResolution();
    const response = await resolveApp().request("/", { method: "POST", body: JSON.stringify({ origin: publicOrigin }) });

    expect(await response.json()).toEqual({ origin: internalOrigin });
    expect(message).toHaveBeenCalledWith("messages", mailboxId, "Msg001");
  });

  test("answers an unknown derived message as not found", async () => {
    stubResolution();
    const response = await resolveApp().request("/", {
      method: "POST",
      body: JSON.stringify({ origin: { ...publicOrigin, messageId: "Msg999" } }),
    });

    expect(response.status).toBe(404);
  });

  test("returns the seed origin with the public message ID the composer sends back", async () => {
    spyOn(publicResources, "publicIds").mockResolvedValue(new Map([[messageId, "Msg001"]]));
    expect(await projectDraftSeed(Promise.resolve(ok({ origin: internalOrigin })))).toEqual(
      ok({ origin: { ...internalOrigin, messageId: "Msg001" } }),
    );
  });

  test("the service names an unresolved public ID as a missing resource, not a schema detail", async () => {
    const result = await drafts.prepareDraftSeed({
      context: { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } },
      mailboxId,
      origin: publicOrigin,
    });

    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
