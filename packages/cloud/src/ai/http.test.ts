import { describe, expect, test } from "bun:test";
import { CODE_RUNTIME_TOOL_NAMES } from "./browser-code-contracts";
import {
  AiConversationDraftInputSchema,
  AiCreateConversationInputSchema,
  AiMessageFeedbackInputSchema,
  AiMessageRetryInputSchema,
  AiSteerInputSchema,
  AiSubmitConversationDraftInputSchema,
  AiTurnInputSchema,
  aiTurnInputToContent,
} from "./http";
import { AI_TURN_ATTACHMENT_MAX_ITEMS } from "./limits";
import type { AiClientToolId, AiMessageFeedback } from "./types";

describe("AI HTTP input helpers", () => {
  test("allows text between sixteen inline references without relaxing the attachment bound", () => {
    const content = Array.from({ length: AI_TURN_ATTACHMENT_MAX_ITEMS }, (_, index) => [
      { type: "text", text: "use " },
      { type: "resource", ref: { type: "core.ai.skill", id: `Skill${index}` }, title: `Skill ${index}`, inline: true },
    ]).flat();
    content.push({ type: "text", text: " please" });
    expect(AiConversationDraftInputSchema.safeParse({ content }).success).toBe(true);
    expect(AiConversationDraftInputSchema.safeParse({ content: content.slice(0, -1).concat(content[1]!) }).success).toBe(false);
    expect(AiMessageRetryInputSchema.safeParse({ content: content.map(() => ({ type: "text", text: "part" })) }).success).toBe(true);
  });
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

  test("accepts the chat UI feedback payloads without a written comment", () => {
    const positive = { rating: "up", reasons: [], comment: null } satisfies Omit<AiMessageFeedback, "updatedAt">;
    const negative = { rating: "down", reasons: ["incorrect"], comment: null } satisfies Omit<AiMessageFeedback, "updatedAt">;
    expect(AiMessageFeedbackInputSchema.parse(positive)).toEqual(positive);
    expect(AiMessageFeedbackInputSchema.parse(negative)).toEqual(negative);
  });

  test("keeps feedback detail requirements when comments are nullable", () => {
    for (const comment of [null, "", "   "]) {
      expect(() => AiMessageFeedbackInputSchema.parse({ rating: "down", reasons: [], comment })).toThrow(
        "Choose a reason or describe the problem",
      );
    }
    expect(() => AiMessageFeedbackInputSchema.parse({ rating: "up", reasons: [], comment: "Wrong date" })).toThrow(
      "Positive feedback cannot include problem details",
    );
    expect(AiMessageFeedbackInputSchema.parse({ rating: "down", reasons: [], comment: "  Wrong date  " })).toEqual({
      rating: "down",
      reasons: [],
      comment: "Wrong date",
    });
    expect(() => AiMessageFeedbackInputSchema.parse({ rating: "down", comment: "x".repeat(1001) })).toThrow();
  });

  for (const { name, schema, input } of [
    { name: "turn", schema: AiTurnInputSchema, input: { message: "Test the app" } },
    { name: "draft submission", schema: AiSubmitConversationDraftInputSchema, input: { draftRevision: 1 } },
  ]) {
    describe(`${name} client tools`, () => {
      test("ignores retired tools and keeps a typed list of known tools", () => {
        const clientToolIds: AiClientToolId[] | undefined = schema.parse({
          ...input,
          clientToolIds: ["code_interact", "code_run"],
        }).clientToolIds;
        expect(clientToolIds).toEqual(["code_run"]);
      });

      test("accepts an older client's full list and preserves known tool order", () => {
        expect(
          schema.parse({
            ...input,
            clientToolIds: [
              "local_bash",
              "code_run",
              "code_action",
              "code_inspect",
              "code_interact",
              "code_stop",
              "code_open",
              "code_export",
              "code_present",
              "code_secret",
            ],
          }).clientToolIds,
        ).toEqual([
          "local_bash",
          "code_run",
          "code_action",
          "code_inspect",
          "code_stop",
          "code_open",
          "code_export",
          "code_present",
          "code_secret",
        ]);
        expect(schema.parse({ ...input, clientToolIds: ["code_secret", "retired_tool", "code_run", "local_bash"] }).clientToolIds).toEqual([
          "code_secret",
          "code_run",
          "local_bash",
        ]);
      });

      test("accepts advertisements longer than the previous ten-item cap", () => {
        const knownIds: AiClientToolId[] = ["local_bash", ...CODE_RUNTIME_TOOL_NAMES];
        const clientToolIds = ["code_interact", "future_tool", ...knownIds];
        expect(clientToolIds.length).toBeGreaterThan(10);
        expect(schema.parse({ ...input, clientToolIds }).clientToolIds).toEqual(knownIds);
      });

      test("accepts absent, empty, and unknown-only advertisements", () => {
        expect(schema.parse(input).clientToolIds).toBeUndefined();
        expect(schema.parse({ ...input, clientToolIds: [] }).clientToolIds).toEqual([]);
        expect(schema.parse({ ...input, clientToolIds: ["arbitrary_tool"] }).clientToolIds).toEqual([]);
      });

      test("rejects duplicate names before filtering unknown tools", () => {
        for (const id of ["local_bash", "code_interact"]) {
          expect(() => schema.parse({ ...input, clientToolIds: [id, id] })).toThrow("Client tool IDs must be unique");
        }
      });

      test("bounds the advertised list before filtering unknown tools", () => {
        const clientToolIds = Array.from({ length: 63 }, (_, index) => `retired_tool_${index}`).concat("code_run");
        expect(schema.parse({ ...input, clientToolIds }).clientToolIds).toEqual(["code_run"]);
        expect(() => schema.parse({ ...input, clientToolIds: [...clientToolIds, "another_retired_tool"] })).toThrow();
      });

      test("bounds names and rejects malformed or non-string IDs", () => {
        for (const id of ["a".repeat(64), "Code_run", "code-run", "local-shell", "1tool", "_tool"]) {
          expect(schema.parse({ ...input, clientToolIds: [id] }).clientToolIds).toEqual([]);
        }
        for (const id of ["a".repeat(65), "", "code.run", "code run", " code_run", "code_run\n", "töol", 123, null, {}]) {
          expect(() => schema.parse({ ...input, clientToolIds: [id] })).toThrow();
        }
      });
    });
  }

  test("steering is text-only and requires an idempotency key", () => {
    expect(AiSteerInputSchema.parse({ message: "  Change course  ", clientRequestId: "request-1" })).toEqual({
      message: "Change course",
      clientRequestId: "request-1",
    });
    expect(() => AiSteerInputSchema.parse({ message: "", clientRequestId: "request-1" })).toThrow();
    expect(() => AiSteerInputSchema.parse({ message: "Change course" })).toThrow();
  });
});
