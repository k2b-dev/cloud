import { describe, expect, test } from "bun:test";
import {
  AiCreateConversationInputSchema,
  AiMessageFeedbackInputSchema,
  AiSteerInputSchema,
  AiTurnInputSchema,
  aiTurnInputToContent,
} from "./http";
import { AI_TURN_ATTACHMENT_MAX_ITEMS } from "./limits";

describe("AI HTTP input helpers", () => {
  test("keeps the message when content contains only file references", () => {
    const input = AiTurnInputSchema.parse({
      message: "Describe this image",
      content: [{ type: "attachment", path: "/photo.png", mediaType: "image/png", size: 123 }],
    });

    expect(aiTurnInputToContent(input)).toEqual([
      { type: "text", text: "Describe this image" },
      { type: "text", text: '<attachment path="/photo.png" media-type="image/png" size="123" />' },
    ]);
  });

  test("does not duplicate message text when content already has text", () => {
    const input = AiTurnInputSchema.parse({
      message: "Ignored fallback",
      content: [
        { type: "text", text: "Explicit prompt" },
        { type: "attachment", path: "/photo.jpg", mediaType: "image/jpeg", size: 123 },
      ],
    });

    expect(aiTurnInputToContent(input)).toEqual([
      { type: "text", text: "Explicit prompt" },
      { type: "text", text: '<attachment path="/photo.jpg" media-type="image/jpeg" size="123" />' },
    ]);
  });

  test("rejects inline image payloads", () => {
    expect(() =>
      AiTurnInputSchema.parse({
        content: [{ type: "file", mediaType: "image/svg+xml", data: "abc123" }],
      }),
    ).toThrow();
  });

  test("accepts sixteen attachments and rejects a seventeenth", () => {
    const attachment = (index: number) => ({
      type: "attachment" as const,
      path: `/file-${index}.txt`,
      mediaType: "text/plain",
      size: 1,
    });
    expect(
      AiTurnInputSchema.parse({
        message: "Review these files",
        content: Array.from({ length: AI_TURN_ATTACHMENT_MAX_ITEMS }, (_, index) => attachment(index)),
      }).content,
    ).toHaveLength(AI_TURN_ATTACHMENT_MAX_ITEMS);
    expect(() =>
      AiTurnInputSchema.parse({
        content: Array.from({ length: AI_TURN_ATTACHMENT_MAX_ITEMS + 1 }, (_, index) => attachment(index)),
      }),
    ).toThrow(`A turn can attach at most ${AI_TURN_ATTACHMENT_MAX_ITEMS} files`);
  });

  test("accepts a project only when creating a conversation", () => {
    expect(AiCreateConversationInputSchema.parse({ projectId: "pRk234" }).projectId).toBe("pRk234");
    expect(() => AiCreateConversationInputSchema.parse({ projectId: "11111111-1111-4111-8111-111111111111" })).toThrow();
    expect(() => AiCreateConversationInputSchema.parse({ projectId: "meeting-summary" })).toThrow();
  });

  test("accepts a bounded structured launch draft and exact capability refs", () => {
    const launch = AiCreateConversationInputSchema.parse({
      draft: {
        content: [
          { type: "text", text: "Help me write this email." },
          { type: "resource", ref: { type: "mail.draft", id: "Draft1" } },
        ],
      },
      preloadTools: [{ appId: "mail", kind: "query", id: "draft.read" }, { name: "text_editor" }],
    });
    expect(launch.draft?.content).toHaveLength(2);
    expect(launch.preloadTools).toEqual([{ appId: "mail", kind: "query", id: "draft.read" }, { name: "text_editor" }]);
    expect(() =>
      AiCreateConversationInputSchema.parse({
        draft: { content: [{ type: "file", path: "/not-uploaded.txt", mediaType: "text/plain", size: 1, version: 1 }] },
      }),
    ).toThrow();
    expect(() =>
      AiCreateConversationInputSchema.parse({
        preloadTools: Array.from({ length: 9 }, () => ({ appId: "mail", kind: "query", id: "draft.read" })),
      }),
    ).toThrow();
    expect(() =>
      AiCreateConversationInputSchema.parse({
        draft: {
          content: [
            {
              type: "resource",
              ref: { type: "mail.draft", id: "Draft1" },
              href: "https://attacker.example/collect",
            },
          ],
        },
      }),
    ).toThrow();
    expect(() =>
      AiCreateConversationInputSchema.parse({
        draft: {
          content: Array.from({ length: AI_TURN_ATTACHMENT_MAX_ITEMS + 1 }, (_, index) => ({
            type: "resource",
            ref: { type: "mail.draft", id: `Draft${index}` },
          })),
        },
      }),
    ).toThrow();
    expect(
      AiCreateConversationInputSchema.parse({
        draft: {
          content: Array.from({ length: AI_TURN_ATTACHMENT_MAX_ITEMS }, (_, index) => ({
            type: "resource" as const,
            ref: { type: "mail.draft", id: `Allowed${index}` },
          })),
        },
      }).draft?.content,
    ).toHaveLength(AI_TURN_ATTACHMENT_MAX_ITEMS);
  });

  test("validates launch attribution and message feedback details", () => {
    expect(AiCreateConversationInputSchema.parse({ launchedByAppId: "mail" }).launchedByAppId).toBe("mail");
    expect(() => AiCreateConversationInputSchema.parse({ launchedByAppId: "Mail App" })).toThrow();
    expect(AiMessageFeedbackInputSchema.parse({ rating: "up" })).toEqual({ rating: "up", reasons: [] });
    expect(AiMessageFeedbackInputSchema.parse({ rating: "down", reasons: ["incorrect"], comment: "Wrong date" })).toEqual({
      rating: "down",
      reasons: ["incorrect"],
      comment: "Wrong date",
    });
    expect(() => AiMessageFeedbackInputSchema.parse({ rating: "down" })).toThrow("Choose a reason or describe the problem");
    expect(() => AiMessageFeedbackInputSchema.parse({ rating: "up", reasons: ["incorrect"] })).toThrow(
      "Positive feedback cannot include problem details",
    );
  });

  test("accepts only the predefined optional local client tool", () => {
    expect(AiTurnInputSchema.parse({ message: "Inspect this checkout", clientToolIds: ["local_bash"] }).clientToolIds).toEqual([
      "local_bash",
    ]);
    expect(() => AiTurnInputSchema.parse({ message: "Inspect this checkout", clientToolIds: ["arbitrary_tool"] })).toThrow();
    expect(() => AiTurnInputSchema.parse({ message: "Inspect this checkout", clientToolIds: ["local_bash", "local_bash"] })).toThrow();
  });

  test("steering is text-only and requires an idempotency key", () => {
    expect(AiSteerInputSchema.parse({ message: "  Change course  ", clientRequestId: "request-1" })).toEqual({
      message: "Change course",
      clientRequestId: "request-1",
    });
    expect(() => AiSteerInputSchema.parse({ message: "", clientRequestId: "request-1" })).toThrow();
    expect(() => AiSteerInputSchema.parse({ message: "Change course" })).toThrow();
  });
});
