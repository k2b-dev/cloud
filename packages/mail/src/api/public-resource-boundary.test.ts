import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { publicResources } from "../service";
import {
  type MailApiContext,
  projectPublicRelations,
  projectPublicResult,
  projectResourcePaths,
  respondPublic,
} from "./public-resource-boundary";

afterEach(() => mock.restore());

describe("Mail public response projection", () => {
  test("localizes final API errors from the request locale", async () => {
    const app = new Hono<MailApiContext>().get("/", (c) => respondPublic(c, fail(err.notFound("Mailbox"))));
    const response = await app.request("/", { headers: { "Accept-Language": "de-CH,de;q=0.9" } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      code: "NOT_FOUND",
      message: "Das Postfach wurde nicht gefunden",
    });
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

    expect(await projectPublicRelations({ result: { conversationId, outboundMessageId: messageId, outboxSubmissionId: deliveryId } })).toEqual({
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
