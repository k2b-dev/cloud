import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { DraftMutationDataSchema } from "./capability-contracts";
import {
  actorCommandInputSchema,
  addConversationLocalTagsSchema,
  assignConversationsSchema,
  type ComposeFormattingWarning,
  cancelScheduledSendInputSchema,
  completeConversationsSchema,
  composeFormattingWarningSchema,
  composePreviewSchema,
  conversationCompletionResultSchema,
  conversationTriageInputSchema,
  conversationTriageUndoInputSchema,
  createConversationCommentSchema,
  createDraftAttachmentUploadSchema,
  createLocalTagSchema,
  createSenderIdentityInputSchema,
  deleteSenderIdentityTransportInputSchema,
  draftContentInputSchema,
  draftEditableContentInputSchema,
  MAIL_CONVERSATION_ASSIGNEE_LIMIT,
  MAX_CONVERSATION_ACTION_MESSAGES,
  mailboxComposeStyleSchema,
  mergeConversationsInputSchema,
  messageStateChangeSchema,
  reassignConversationMessageInputSchema,
  scheduledSendPageSchema,
  senderDispositionInputSchema,
  splitConversationInputSchema,
  updateConversationCollaborationSchema,
  updateConversationCommentSchema,
  updateConversationSummarySchema,
  updateLocalTagSchema,
  updateSenderIdentityTransportInputSchema,
} from "./contracts";

describe("conversation tag contracts", () => {
  test("normalizes valid colors and rejects ambiguous tag colors", () => {
    expect(createLocalTagSchema.parse({ name: "Priority", color: " #AABBCC " })).toEqual({
      name: "Priority",
      color: "#aabbcc",
    });
    expect(createLocalTagSchema.safeParse({ name: "Priority", color: "red" }).success).toBe(false);
    expect(updateLocalTagSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(updateLocalTagSchema.safeParse({ expectedRevision: 1, color: "#0f766e" }).success).toBe(true);
  });

  test("bounds additive bulk assignments and rejects duplicate ids", () => {
    const conversationId = "Conv01";
    const tagId = "Tag001";
    expect(addConversationLocalTagsSchema.safeParse({ conversationIds: [conversationId], tagIds: [tagId] }).success).toBe(true);
    expect(
      addConversationLocalTagsSchema.safeParse({
        conversationIds: ["00000000-0000-4000-8000-000000000001"],
        tagIds: [tagId],
      }).success,
    ).toBe(false);
    expect(addConversationLocalTagsSchema.safeParse({ conversationIds: [conversationId, conversationId], tagIds: [tagId] }).success).toBe(
      false,
    );
    expect(addConversationLocalTagsSchema.safeParse({ conversationIds: [conversationId], tagIds: [tagId, tagId] }).success).toBe(false);
    expect(addConversationLocalTagsSchema.safeParse({ conversationIds: [], tagIds: [tagId] }).success).toBe(false);
  });
});

describe("conversation summary contracts", () => {
  test("normalizes surrounding whitespace and treats an empty summary as removal", () => {
    expect(updateConversationSummarySchema.parse({ expectedSummaryRevision: 2, summary: "  Current context\n" })).toEqual({
      expectedSummaryRevision: 2,
      summary: "Current context",
    });
    expect(updateConversationSummarySchema.parse({ expectedSummaryRevision: 2, summary: "   " })).toEqual({
      expectedSummaryRevision: 2,
      summary: null,
    });
  });
});

const draftEditableContent = {
  senderIdentityId: "Send01",
  to: [],
  cc: [],
  bcc: [],
  subject: "Subject",
  body: "Body",
  format: "plain" as const,
};

describe("mail draft contracts", () => {
  test("signature choices distinguish omission, none, and a public template ID", () => {
    expect(draftEditableContentInputSchema.parse(draftEditableContent)).not.toHaveProperty("signatureTemplateId");
    expect(draftEditableContentInputSchema.parse({ ...draftEditableContent, signatureTemplateId: null }).signatureTemplateId).toBeNull();
    expect(draftEditableContentInputSchema.parse({ ...draftEditableContent, signatureTemplateId: "Sign01" }).signatureTemplateId).toBe(
      "Sign01",
    );
    expect(
      draftEditableContentInputSchema.safeParse({ ...draftEditableContent, signatureTemplateId: crypto.randomUUID() }).success,
    ).toBeFalse();
  });
  test("keeps draft context immutable and bounds attachment uploads", () => {
    expect(draftEditableContentInputSchema.safeParse({ ...draftEditableContent, intent: "reply" }).success).toBe(false);
    expect(
      draftContentInputSchema.safeParse({
        ...draftEditableContent,
        conversationId: "Conv01",
        intent: "reply",
        sourceMessageId: "Msg001",
        includeSourceAttachments: false,
      }).success,
    ).toBe(true);
    expect(
      draftContentInputSchema.safeParse({
        ...draftEditableContent,
        conversationId: "Conv01",
        intent: "forward",
        sourceMessageId: "Msg001",
        includeSourceAttachments: true,
      }).success,
    ).toBe(true);
    expect(
      draftContentInputSchema.safeParse({
        ...draftEditableContent,
        sourceMessageId: "00000000-0000-4000-8000-000000000003",
      }).success,
    ).toBe(false);
    expect(
      createDraftAttachmentUploadSchema.safeParse({
        filename: "too-large.bin",
        contentType: "application/octet-stream",
        byteLength: 100 * 1024 * 1024 + 1,
      }).success,
    ).toBe(false);
  });
});

describe("scheduled send contracts", () => {
  test("requires an explicit cancellation disposition and bounded projection", () => {
    expect(cancelScheduledSendInputSchema.safeParse({ disposition: "draft" }).success).toBe(true);
    expect(cancelScheduledSendInputSchema.safeParse({ disposition: "discard" }).success).toBe(true);
    expect(cancelScheduledSendInputSchema.safeParse({}).success).toBe(false);
    expect(cancelScheduledSendInputSchema.safeParse({ disposition: "delete" }).success).toBe(false);

    const scheduledSend = {
      id: "Deliv1",
      commandId: "00000000-0000-4000-8000-000000000002",
      draftId: "Draft1",
      conversationId: null,
      intent: "new",
      to: [{ name: null, address: "recipient@example.com" }],
      cc: [],
      bcc: [],
      subject: "Scheduled",
      bodyPreview: "Preview",
      scheduledAt: "2026-07-18T09:00:00.000Z",
      nextAttemptAt: null,
      state: "scheduled",
      attempt: 0,
      lastErrorCode: null,
      lastError: null,
      scheduledBy: { kind: "user", displayName: "Ada" },
      createdAt: "2026-07-17T09:00:00.000Z",
    };
    const page = { items: [scheduledSend], nextCursor: null, total: 1 };
    expect(scheduledSendPageSchema.safeParse(page).success).toBe(true);
    expect(
      scheduledSendPageSchema.safeParse({
        ...page,
        items: [{ ...scheduledSend, id: "00000000-0000-4000-8000-000000000001" }],
      }).success,
    ).toBe(false);
  });

  test("bounds how far ahead a send can be scheduled", () => {
    const command = {
      kind: "send",
      draftId: "Draft1",
      expectedDraftRevision: 1,
      expectedContentHash: "a".repeat(64),
      senderIdentityId: "Ident1",
      idempotencyKey: "00000000-0000-4000-8000-000000000003",
    };
    const inDays = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString();
    expect(actorCommandInputSchema.safeParse({ ...command, scheduledAt: inDays(300) }).success).toBe(true);
    const tooFar = actorCommandInputSchema.safeParse({ ...command, scheduledAt: inDays(400) });
    expect(tooFar.success).toBe(false);
    if (!tooFar.success) expect(tooFar.error.issues[0]?.message).toBe("A send can be scheduled at most one year in the future");
  });
});

describe("sender identity contracts", () => {
  test("requires an internal label and supplies safe identity defaults", () => {
    expect(
      createSenderIdentityInputSchema.safeParse({
        fromAddress: "sender@example.com",
      }).success,
    ).toBe(false);
    expect(
      createSenderIdentityInputSchema.parse({
        label: "Work",
        fromAddress: "sender@example.com",
      }),
    ).toMatchObject({
      label: "Work",
      displayName: "",
      defaultCc: [],
      defaultBcc: [],
      defaultFormat: "markdown",
      defaultPriority: "normal",
      defaultDeliveryReceipt: false,
      defaultReadReceipt: false,
    });
  });

  test("accepts complete vCards and rejects partial identity cards", () => {
    expect(
      createSenderIdentityInputSchema.safeParse({
        label: "Work",
        fromAddress: "sender@example.com",
        vcard: "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Work\r\nEND:VCARD",
      }).success,
    ).toBe(true);
    expect(
      createSenderIdentityInputSchema.safeParse({
        label: "Work",
        fromAddress: "sender@example.com",
        vcard: "FN:Work",
      }).success,
    ).toBe(false);
  });

  test("strips retired automatic-reply sender controls", () => {
    expect(
      createSenderIdentityInputSchema.parse({
        label: "Work",
        fromAddress: "sender@example.com",
        authenticationPolicy: { automation: "disabled" },
      }),
    ).not.toHaveProperty("authenticationPolicy");
  });
});

describe("mail message state contracts", () => {
  test("accepts a bounded conversation move to a concrete folder", () => {
    expect(
      conversationTriageInputSchema.safeParse({
        kind: "move_to_folder",
        sourceFolderId: "Fold01",
        destinationFolderId: "Fold02",
        idempotencyKey: "move:test",
      }).success,
    ).toBe(true);
    expect(
      conversationTriageInputSchema.safeParse({
        kind: "move_to_folder",
        sourceFolderId: "00000000-0000-4000-8000-000000000001",
        destinationFolderId: "Fold02",
        idempotencyKey: "move:legacy",
      }).success,
    ).toBe(false);
  });

  test("keeps system flags and provider keywords in separate namespaces", () => {
    expect(
      messageStateChangeSchema.safeParse({
        addFlags: ["seen"],
        removeFlags: [],
        addKeywords: [],
        removeKeywords: ["seen"],
      }).success,
    ).toBe(true);
  });

  test("rejects contradictory changes within one namespace", () => {
    expect(
      messageStateChangeSchema.safeParse({
        addFlags: ["seen"],
        removeFlags: ["seen"],
        addKeywords: [],
        removeKeywords: [],
      }).success,
    ).toBe(false);
    expect(
      messageStateChangeSchema.safeParse({
        addFlags: [],
        removeFlags: [],
        addKeywords: ["FollowUp"],
        removeKeywords: ["followup"],
      }).success,
    ).toBe(false);
  });
});

describe("sender identity transport contracts", () => {
  const transport = {
    host: "smtp.example.com",
    port: 587,
    tlsMode: "starttls" as const,
    username: "sender@example.com",
  };

  test("requires an explicit revision for every transport mutation", () => {
    expect(updateSenderIdentityTransportInputSchema.safeParse(transport).success).toBe(false);
    expect(updateSenderIdentityTransportInputSchema.safeParse({ ...transport, expectedRevision: 0 }).success).toBe(true);
    expect(deleteSenderIdentityTransportInputSchema.safeParse({ expectedRevision: 0 }).success).toBe(false);
    expect(deleteSenderIdentityTransportInputSchema.safeParse({ expectedRevision: 1 }).success).toBe(true);
  });

  test("accepts credential rotation without requiring a secret on metadata updates", () => {
    expect(
      updateSenderIdentityTransportInputSchema.safeParse({
        ...transport,
        expectedRevision: 2,
        secret: { kind: "password", password: "rotated-secret" },
      }).success,
    ).toBe(true);
    expect(
      updateSenderIdentityTransportInputSchema.safeParse({
        ...transport,
        expectedRevision: 2,
        secret: { kind: "password", password: "" },
      }).success,
    ).toBe(false);
  });
});

describe("mail collaboration contracts", () => {
  test("requires one collaboration change", () => {
    expect(updateConversationCollaborationSchema.safeParse({ expectedRevision: 1 }).success).toBe(false);
    expect(updateConversationCollaborationSchema.safeParse({ expectedRevision: 1, assigneeUserIds: [] }).success).toBe(true);
    expect(updateConversationCollaborationSchema.safeParse({ expectedRevision: 1, completion: "done" }).success).toBe(true);
    expect(updateConversationCollaborationSchema.safeParse({ expectedRevision: 1, completion: "open" }).success).toBe(true);
    expect(updateConversationCollaborationSchema.safeParse({ expectedRevision: 1, workStatus: "waiting" }).success).toBe(false);
    expect(
      updateConversationCollaborationSchema.safeParse({
        expectedRevision: 1,
        completion: "done",
        snoozedUntil: "2026-08-15T18:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("preserves comment whitespace while rejecting blank comments", () => {
    const parsed = createConversationCommentSchema.safeParse({ body: "  useful context  " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.body).toBe("  useful context  ");
    expect(createConversationCommentSchema.safeParse({ body: " \n\t " }).success).toBe(false);
    expect(updateConversationCommentSchema.safeParse({ expectedRevision: 1, body: "Updated" }).success).toBe(true);
  });

  test("requires explicit confirmation and unique message ids for manual threading", () => {
    const sourceConversationId = "Conv01";
    const messageId = "Msg001";
    expect(
      mergeConversationsInputSchema.safeParse({
        sourceConversationId,
        expectedTargetRevision: 1,
        expectedSourceRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      splitConversationInputSchema.safeParse({
        messageIds: [messageId, messageId],
        expectedRevision: 1,
        confirm: true,
      }).success,
    ).toBe(false);
    expect(
      reassignConversationMessageInputSchema.safeParse({
        targetConversationId: sourceConversationId,
        expectedSourceRevision: 1,
        expectedTargetRevision: 1,
        confirm: true,
      }).success,
    ).toBe(true);
    expect(
      reassignConversationMessageInputSchema.safeParse({
        targetConversationId: sourceConversationId,
        expectedSourceRevision: 1,
        expectedTargetRevision: 1,
      }).success,
    ).toBe(false);
    expect(
      reassignConversationMessageInputSchema.safeParse({
        targetConversationId: "00000000-0000-4000-8000-000000000001",
        expectedSourceRevision: 1,
        expectedTargetRevision: 1,
        confirm: true,
      }).success,
    ).toBe(false);
  });
});

test("assignment schemas bound sets and require users for add and remove", () => {
  const userId = "00000000-0000-4000-8000-000000000001";
  for (const mode of ["add", "remove", "replace"] as const) {
    expect(assignConversationsSchema.safeParse({ conversationIds: ["Conv01"], assigneeUserIds: [userId], mode }).success).toBeTrue();
    expect(assignConversationsSchema.safeParse({ conversationIds: ["Conv01"], assigneeUserIds: [], mode }).success).toBe(
      mode === "replace",
    );
  }
  const oversized = Array.from({ length: MAIL_CONVERSATION_ASSIGNEE_LIMIT + 1 }, () => userId);
  expect(
    assignConversationsSchema.safeParse({ conversationIds: ["Conv01"], assigneeUserIds: oversized, mode: "replace" }).success,
  ).toBeFalse();
  expect(updateConversationCollaborationSchema.safeParse({ expectedRevision: 1, assigneeUserIds: oversized }).success).toBeFalse();
  expect(
    assignConversationsSchema.safeParse({ conversationIds: ["Conv01"], assigneeUserIds: [], mode: "replace", assigneeUserId: null })
      .success,
  ).toBeFalse();
});

test("assignment revision fences apply only to a single unassigned claim", () => {
  const input = {
    conversationIds: ["Conv01"],
    assigneeUserIds: ["00000000-0000-4000-8000-000000000001"],
    mode: "add",
    onlyIfUnassigned: true,
    expectedRevision: 2,
  };
  expect(assignConversationsSchema.safeParse(input).success).toBeTrue();
  expect(assignConversationsSchema.safeParse({ ...input, onlyIfUnassigned: undefined }).success).toBeFalse();
  expect(assignConversationsSchema.safeParse({ ...input, conversationIds: ["Conv01", "Conv02"] }).success).toBeFalse();
});

describe("compose formatting contracts", () => {
  test("keeps HTML warnings and adds strict stored-design warnings", () => {
    const warnings: ComposeFormattingWarning[] = [
      { code: "unsupported_element", element: "small" },
      { code: "unsupported_attribute", element: "span", attribute: "class" },
      { code: "unsupported_link", element: "a" },
      { code: "ignored_mailbox_css", property: "font-family" },
      { code: "ignored_mailbox_css", property: "@media" },
      { code: "ignored_mailbox_css" },
    ];
    for (const warning of warnings) expect(composeFormattingWarningSchema.parse(warning)).toEqual(warning);
    for (const warning of [
      { code: "ignored_mailbox_css", element: "p" },
      { code: "ignored_mailbox_css", property: "x".repeat(65) },
      { code: "unsupported_element", element: "p", property: "color" },
      { code: "unsupported_element" },
    ])
      expect(composeFormattingWarningSchema.safeParse(warning).success).toBe(false);
  });

  test("requires design warnings on style reads and serializes preview and capability contracts", () => {
    const style = { mailboxId: "Mail01", customCss: "", revision: 1, updatedAt: "2026-07-17T00:00:00.000Z" };
    expect(mailboxComposeStyleSchema.safeParse(style).success).toBe(false);
    expect(mailboxComposeStyleSchema.parse({ ...style, formattingWarnings: [] }).formattingWarnings).toEqual([]);
    const formattingWarnings: ComposeFormattingWarning[] = [{ code: "ignored_mailbox_css", property: "font-family" }];
    expect(composePreviewSchema.parse({ html: "<p>Hello</p>", text: "Hello", formattingWarnings }).formattingWarnings).toEqual(
      formattingWarnings,
    );
    for (const schema of [mailboxComposeStyleSchema, composePreviewSchema, DraftMutationDataSchema]) {
      const serialized = JSON.stringify(z.toJSONSchema(schema));
      expect(serialized).toContain("ignored_mailbox_css");
      expect(JSON.parse(serialized)).toBeDefined();
    }
  });
});

describe("sender disposition contracts", () => {
  const input = { match: "domain", value: " example.com ", idempotencyKey: crypto.randomUUID() };

  test("sender disposition accepts exactly one role or public folder destination and trims values", () => {
    expect(senderDispositionInputSchema.parse({ ...input, destination: "archive" }).value).toBe("example.com");
    expect(senderDispositionInputSchema.safeParse({ ...input, folderId: "Foldr1" }).success).toBe(true);
    for (const destination of [{}, { destination: "trash", folderId: "Foldr1" }]) {
      const result = senderDispositionInputSchema.safeParse({ ...input, ...destination });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues[0]?.message).toContain("exactly one");
    }
  });

  test("sender disposition is strict, bounds values, and requires a UUID command key", () => {
    const valid = { ...input, destination: "trash" };
    for (const changes of [
      { extra: true },
      { idempotencyKey: "arbitrary-key" },
      { value: " " },
      { value: "a".repeat(321) },
      { match: "list" },
      { destination: "junk" },
      { destination: undefined, folderId: crypto.randomUUID() },
    ])
      expect(senderDispositionInputSchema.safeParse({ ...valid, ...changes }).success).toBe(false);
  });
});

describe("conversation action undo contracts", () => {
  test("accepts command UUIDs up to one conversation action's command bound", () => {
    const id = crypto.randomUUID();
    expect(conversationTriageUndoInputSchema.safeParse({ commandIds: [id] }).success).toBe(true);
    expect(conversationTriageUndoInputSchema.safeParse({ commandIds: Array(MAX_CONVERSATION_ACTION_MESSAGES).fill(id) }).success).toBe(
      true,
    );
    expect(conversationTriageUndoInputSchema.safeParse({ commandIds: Array(MAX_CONVERSATION_ACTION_MESSAGES + 1).fill(id) }).success).toBe(
      false,
    );
    expect(conversationTriageUndoInputSchema.safeParse({ commandIds: [] }).success).toBe(false);
    expect(conversationTriageUndoInputSchema.safeParse({ commandIds: ["cmd123"] }).success).toBe(false);
    expect(conversationTriageUndoInputSchema.safeParse({ commandIds: [id], extra: true }).success).toBe(false);
  });
});

describe("batch conversation completion contracts", () => {
  test("accepts all work statuses and complete optional batch revision fences", () => {
    const conversationIds = Array.from({ length: 50 }, (_, index) => `Cv${String(index).padStart(4, "0")}`);
    for (const completion of ["done", "open", "waiting", "needs_action"] as const) {
      expect(completeConversationsSchema.parse({ conversationIds, completion })).toEqual({ conversationIds, completion });
      const expectedRevisions = Object.fromEntries(conversationIds.map((id) => [id, 2]));
      expect(completeConversationsSchema.parse({ conversationIds, completion, expectedRevisions }).expectedRevisions).toEqual(
        expectedRevisions,
      );
    }
    for (const input of [
      { conversationIds: [], completion: "done" },
      { conversationIds: [...conversationIds, "Cv9999"], completion: "done" },
      { conversationIds: ["Convo1", "Convo1"], completion: "done" },
      { conversationIds: ["invalid-id"], completion: "done" },
      { conversationIds: ["Convo1"], completion: "unknown" },
      { conversationIds: ["Convo1", "Convo2"], completion: "waiting", expectedRevisions: { Convo1: 1 } },
      { conversationIds: ["Convo1"], completion: "done", expectedRevision: 1 },
    ])
      expect(completeConversationsSchema.safeParse(input).success).toBeFalse();
  });
  test("requires resulting state and revision only on successful items", () => {
    expect(
      conversationCompletionResultSchema.safeParse({
        completion: "open",
        results: [
          { conversationId: "Convo1", status: "ok", workStatus: "waiting", revision: 2 },
          { conversationId: "Convo2", status: "not_found" },
        ],
      }).success,
    ).toBeTrue();
    expect(
      conversationCompletionResultSchema.safeParse({ completion: "done", results: [{ conversationId: "Convo1", status: "ok" }] }).success,
    ).toBeFalse();
  });
});
