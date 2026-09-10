import { describe, expect, test } from "bun:test";
import {
  activateWorkflowInputSchema,
  actorCommandInputSchema,
  addConversationLocalTagsSchema,
  automaticReplyPreviewInputSchema,
  cancelScheduledSendInputSchema,
  conversationTriageInputSchema,
  createAutomaticReplyConfigurationSchema,
  createAutomaticReplySetupSchema,
  createConversationCommentSchema,
  createDraftAttachmentUploadSchema,
  createIncomingAutomationSchema,
  createLocalTagSchema,
  createSenderIdentityInputSchema,
  createWorkflowInputSchema,
  createWorkflowVersionInputSchema,
  deactivateWorkflowInputSchema,
  deleteSenderIdentityTransportInputSchema,
  draftContentInputSchema,
  draftEditableContentInputSchema,
  mailSearchExpressionSchema,
  mergeConversationsInputSchema,
  messageStateChangeSchema,
  parseConnectorCapabilities,
  previewIncomingAutomationMatchesInputSchema,
  reassignConversationMessageInputSchema,
  restoreWorkflowVersionInputSchema,
  scheduledSendPageSchema,
  splitConversationInputSchema,
  startIncomingAutomationBackfillInputSchema,
  updateAutomaticReplyConfigurationSchema,
  updateAutomaticReplySetupSchema,
  updateConversationCollaborationSchema,
  updateConversationCommentSchema,
  updateConversationSummarySchema,
  updateLocalTagSchema,
  updateSenderIdentityTransportInputSchema,
  updateWorkflowMetadataInputSchema,
  validateWorkflowInputSchema,
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

describe("automatic reply configuration contracts", () => {
  const configuration = {
    name: "Out of office",
    enabled: true,
    senderIdentityId: "Send01",
    subject: "Re: original subject",
    body: "I am away.",
    format: "markdown" as const,
    ensureReference: false,
    minimumIntervalHours: 168,
    inactiveBehavior: "skip" as const,
    schedule: {
      mode: "windows" as const,
      timeZone: "Europe/Berlin",
      activeRanges: [{ from: "2026-07-20", to: "2026-08-03" }],
      weeklyWindows: [{ weekday: 1 as const, start: "00:00", end: "24:00" }],
      exceptions: [],
    },
  };

  test("requires at least one hour between replies to one recipient", () => {
    expect(createAutomaticReplyConfigurationSchema.safeParse({ ...configuration, minimumIntervalHours: 0 }).success).toBe(false);
    expect(createAutomaticReplyConfigurationSchema.safeParse({ ...configuration, minimumIntervalHours: 1 }).success).toBe(true);
  });

  test("keeps presets out of the persisted contract", () => {
    expect(createAutomaticReplyConfigurationSchema.safeParse(configuration).success).toBe(true);
    expect(
      createAutomaticReplyConfigurationSchema.safeParse({
        ...configuration,
        senderIdentityId: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
    expect(createAutomaticReplyConfigurationSchema.safeParse({ ...configuration, schedule: { mode: "always" } }).success).toBe(true);
    expect(
      createAutomaticReplyConfigurationSchema.safeParse({
        ...configuration,
        schedule: {
          timeZone: "Europe/Berlin",
          activeRanges: [],
          weeklyWindows: [],
          exceptions: [],
        },
      }).success,
    ).toBe(false);
    expect(createAutomaticReplyConfigurationSchema.safeParse({ ...configuration, preset: "out-of-office" }).success).toBe(false);
    expect(
      updateAutomaticReplyConfigurationSchema.safeParse({
        expectedRevision: 1,
        ...configuration,
      }).success,
    ).toBe(true);
    expect(updateAutomaticReplyConfigurationSchema.safeParse({ expectedRevision: 1, ...configuration, body: "  " }).success).toBe(false);
  });

  test("accepts one atomic automatic reply and reference configuration payload", () => {
    const referenceConfiguration = {
      expectedRevision: null,
      pattern: "REF-{{ year }}-{{ sequence | pad_start: 6 }}",
      enabled: true,
      includeInReplySubjects: true,
    };
    expect(
      createAutomaticReplySetupSchema.safeParse({
        automaticReply: { ...configuration, ensureReference: true },
        referenceConfiguration,
      }).success,
    ).toBe(true);
    expect(
      updateAutomaticReplySetupSchema.safeParse({
        automaticReply: { expectedRevision: 1, ...configuration, ensureReference: true },
        referenceConfiguration,
      }).success,
    ).toBe(true);
    expect(createAutomaticReplySetupSchema.safeParse(configuration).success).toBe(false);
    expect(
      createAutomaticReplySetupSchema.safeParse({
        automaticReply: configuration,
        referenceConfiguration,
      }).success,
    ).toBe(false);
  });

  test("requires the reference format for reference-enabled previews", () => {
    const preview = {
      senderIdentityId: "Send01",
      subject: "Re: {{ inputs.message.subject }}",
      body: "{{ reference.value }}",
      format: "markdown",
      ensureReference: true,
      referencePattern: null,
    };
    expect(automaticReplyPreviewInputSchema.safeParse(preview).success).toBe(false);
    expect(
      automaticReplyPreviewInputSchema.safeParse({
        ...preview,
        referencePattern: "REF-{{ year }}-{{ sequence | pad_start: 6 }}",
      }).success,
    ).toBe(true);
  });
});

describe("incoming automation contracts", () => {
  const textId = "00000000-0000-4000-8000-000000000001";
  const classifierId = "00000000-0000-4000-8000-000000000002";
  test("accepts normal workflow outputs, references, conditions, and multiple consumers", () => {
    const result = createIncomingAutomationSchema.safeParse({
      name: "Triage and draft",
      scope: { mode: "all" },
      steps: [
        {
          id: "00000000-0000-4000-8000-000000000010",
          kind: "mail_action",
          action: { kind: "add_local_tag", tagId: "Tag001" },
        },
        {
          id: classifierId,
          kind: "ai_classify",
          instructions: "Choose the best category",
          choices: [
            { name: "Important", description: "Needs attention" },
            { name: "Routine", description: "Routine message" },
          ],
        },
        {
          id: "00000000-0000-4000-8000-000000000011",
          kind: "if",
          condition: { sourceStepId: classifierId, operator: "equals", value: "Important" },
          then: [
            { id: "00000000-0000-4000-8000-000000000012", kind: "mail_action", action: { kind: "set_status", status: "needs_action" } },
          ],
          else: [{ id: "00000000-0000-4000-8000-000000000013", kind: "mail_action", action: { kind: "add_keyword", keyword: "Routine" } }],
        },
        {
          id: textId,
          kind: "ai_generate_text",
          instructions: "Write a concise reply",
          maxOutputChars: 2_000,
        },
        {
          id: "00000000-0000-4000-8000-000000000014",
          kind: "create_reply_draft",
          body: { kind: "step_output", sourceStepId: textId },
          senderIdentityId: "Send01",
        },
        { id: "00000000-0000-4000-8000-000000000017", kind: "add_comment", body: { kind: "custom", value: "AI summary reviewed" } },
        { id: "00000000-0000-4000-8000-000000000018", kind: "set_summary", body: { kind: "step_output", sourceStepId: textId } },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.enabled).toBe(false);
    expect(
      createIncomingAutomationSchema.safeParse({
        name: "Legacy identity",
        scope: { mode: "all" },
        steps: [
          {
            id: "00000000-0000-4000-8000-000000000019",
            kind: "create_reply_draft",
            body: { kind: "custom", value: "Reply" },
            senderIdentityId: "00000000-0000-4000-8000-000000000015",
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects forward references and incompatible output types", () => {
    const result = createIncomingAutomationSchema.safeParse({
      name: "Invalid dependencies",
      scope: { mode: "all" },
      steps: [
        {
          id: "00000000-0000-4000-8000-000000000020",
          kind: "create_reply_draft",
          body: { kind: "step_output", sourceStepId: textId },
          senderIdentityId: "00000000-0000-4000-8000-000000000021",
        },
        { id: textId, kind: "ai_generate_text", instructions: "Write a reply", maxOutputChars: 2_000 },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("accepts reply drafts, comments, and summaries with custom text without AI", () => {
    const result = createIncomingAutomationSchema.safeParse({
      name: "Add standard content",
      scope: { mode: "all" },
      steps: [
        {
          id: "00000000-0000-4000-8000-000000000021",
          kind: "create_reply_draft",
          body: { kind: "custom", value: "Thanks for your message. We will review it shortly." },
          senderIdentityId: "Send01",
        },
        {
          id: "00000000-0000-4000-8000-000000000023",
          kind: "add_comment",
          body: { kind: "custom", value: "Review during the next support shift." },
        },
        {
          id: "00000000-0000-4000-8000-000000000024",
          kind: "set_summary",
          body: { kind: "custom", value: "Waiting for support review." },
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  test("keeps alternative classification effects independent and rejects conflicting effects afterward", () => {
    const steps = [
      {
        id: classifierId,
        kind: "ai_classify" as const,
        instructions: "Choose the destination",
        choices: [
          { name: "Important", description: "Needs attention" },
          { name: "Routine", description: "Routine message" },
        ],
      },
      {
        id: "00000000-0000-4000-8000-000000000030",
        kind: "if" as const,
        condition: { sourceStepId: classifierId, operator: "equals" as const, value: "Important" },
        then: [{ id: "00000000-0000-4000-8000-000000000031", kind: "mail_action" as const, action: { kind: "junk" as const } }],
        else: [{ id: "00000000-0000-4000-8000-000000000032", kind: "mail_action" as const, action: { kind: "trash" as const } }],
      },
    ];
    expect(createIncomingAutomationSchema.safeParse({ name: "Alternative effects", scope: { mode: "all" }, steps }).success).toBe(true);
    expect(
      createIncomingAutomationSchema.safeParse({
        name: "Conflicting effect",
        scope: { mode: "all" },
        steps: [...steps, { id: "00000000-0000-4000-8000-000000000033", kind: "mail_action", action: { kind: "mark_read" } }],
      }).success,
    ).toBe(false);
  });

  test("allows sparse routes and rejects effects that can co-occur after multi-classification", () => {
    const sparse = [
      {
        id: classifierId,
        kind: "ai_classify" as const,
        instructions: "Choose the destination",
        choices: [
          { name: "Important", description: "Needs attention" },
          { name: "Routine", description: "Routine message" },
        ],
      },
      {
        id: "00000000-0000-4000-8000-000000000040",
        kind: "if" as const,
        condition: { sourceStepId: classifierId, operator: "equals" as const, value: "Important" },
        then: [
          {
            id: "00000000-0000-4000-8000-000000000043",
            kind: "mail_action" as const,
            action: { kind: "set_status" as const, status: "needs_action" as const },
          },
        ],
        else: [],
      },
    ];
    expect(createIncomingAutomationSchema.safeParse({ name: "Sparse routing", scope: { mode: "all" }, steps: sparse }).success).toBe(true);

    const multiClassifier = {
      ...sparse[0]!,
      kind: "ai_classify_many" as const,
      maxChoices: 2,
      choices: [
        { name: "Important", description: "Needs attention" },
        { name: "Routine", description: "Routine message" },
      ],
    };
    const result = createIncomingAutomationSchema.safeParse({
      name: "Unsafe multi routing",
      scope: { mode: "all" },
      steps: [
        multiClassifier,
        {
          id: "00000000-0000-4000-8000-000000000044",
          kind: "if",
          condition: { sourceStepId: classifierId, operator: "includes", value: "Important" },
          then: [{ id: "00000000-0000-4000-8000-000000000041", kind: "mail_action", action: { kind: "junk" } }],
          else: [],
        },
        {
          id: "00000000-0000-4000-8000-000000000045",
          kind: "if",
          condition: { sourceStepId: classifierId, operator: "includes", value: "Routine" },
          then: [{ id: "00000000-0000-4000-8000-000000000042", kind: "mail_action", action: { kind: "trash" } }],
          else: [],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((issue) => issue.message.includes("only one provider message action"))).toBe(true);
    expect(
      createIncomingAutomationSchema.safeParse({
        name: "Single-result multi routing",
        scope: { mode: "all" },
        steps: [
          { ...multiClassifier, maxChoices: 1 },
          {
            id: "00000000-0000-4000-8000-000000000046",
            kind: "if",
            condition: { sourceStepId: classifierId, operator: "includes", value: "Important" },
            then: [{ id: "00000000-0000-4000-8000-000000000047", kind: "mail_action", action: { kind: "junk" } }],
            else: [],
          },
          {
            id: "00000000-0000-4000-8000-000000000048",
            kind: "if",
            condition: { sourceStepId: classifierId, operator: "includes", value: "Routine" },
            then: [{ id: "00000000-0000-4000-8000-000000000049", kind: "mail_action", action: { kind: "trash" } }],
            else: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("requires bounded, explicit inputs for previews and existing-message backfills", () => {
    expect(previewIncomingAutomationMatchesInputSchema.safeParse({ scope: { mode: "all" } }).success).toBe(true);
    expect(
      startIncomingAutomationBackfillInputSchema.safeParse({
        operationId: "6962b64e-6de0-4e73-838b-f067d805f46e",
        expectedRevision: 2,
      }).success,
    ).toBe(true);
    expect(
      startIncomingAutomationBackfillInputSchema.safeParse({
        operationId: "6962b64e-6de0-4e73-838b-f067d805f46e",
        expectedRevision: 0,
      }).success,
    ).toBe(false);
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
      authenticationPolicy: { automation: "mailbox" },
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

  test("preserves an explicit automation opt-out", () => {
    expect(
      createSenderIdentityInputSchema.parse({
        label: "Work",
        fromAddress: "sender@example.com",
        authenticationPolicy: { automation: "disabled" },
      }).authenticationPolicy,
    ).toEqual({ automation: "disabled" });
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
    expect(updateConversationCollaborationSchema.safeParse({ expectedRevision: 1, assigneeUserId: null }).success).toBe(true);
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

describe("mail workflow contracts", () => {
  test("accepts only the canonical discriminated search AST", () => {
    const expressions = [
      { type: "text", field: "participants", query: "customer@example.com", match: "exact" },
      { type: "text", field: "attachment_name", query: "invoice", match: "contains" },
      { type: "text", field: "comment", query: "follow up", match: "words" },
      { type: "text", field: "reference", query: "SUP-42", match: "exact" },
      { type: "text", field: "folder", query: "Support", match: "phrase" },
      { type: "text", field: "tag", query: "Priority", match: "exact" },
      { type: "text", field: "keyword", query: "RemoteImportant", match: "exact" },
      { type: "date", field: "internal_date", operator: "after", value: "2026-07-01T00:00:00.000Z" },
      { type: "size", field: "attachment", operator: "at_least", bytes: 1024 },
      { type: "work_status", value: "waiting" },
      { type: "assignee", userId: null },
      { type: "snoozed", value: false },
      { type: "folder_id", folderId: "Foldr1" },
      { type: "local_tag_id", tagId: "Tag001" },
      { type: "assigned_to_me" },
      { type: "all" },
    ];
    for (const expression of expressions) expect(mailSearchExpressionSchema.safeParse(expression).success).toBe(true);
    expect(mailSearchExpressionSchema.safeParse({ type: "folder_id", folderId: crypto.randomUUID() }).success).toBe(false);
    expect(mailSearchExpressionSchema.safeParse({ type: "local_tag_id", tagId: crypto.randomUUID() }).success).toBe(false);
    expect(mailSearchExpressionSchema.safeParse({ field: "subject", query: "legacy" }).success).toBe(false);
    expect(mailSearchExpressionSchema.safeParse({ and: expressions }).success).toBe(false);
  });

  test("rejects deeply nested search expressions without overflowing the stack", () => {
    let expression: unknown = { type: "text", field: "subject", query: "invoice", match: "contains" };
    for (let depth = 0; depth < 10_000; depth += 1) expression = { type: "not", expression };

    expect(() => mailSearchExpressionSchema.safeParse(expression)).not.toThrow();
    expect(mailSearchExpressionSchema.safeParse(expression).success).toBe(false);

    const cyclic: { type: "not"; expression?: unknown } = { type: "not" };
    cyclic.expression = cyclic;
    expect(() => mailSearchExpressionSchema.safeParse(cyclic)).not.toThrow();
    expect(mailSearchExpressionSchema.safeParse(cyclic).success).toBe(false);
  });

  test("keeps exact YAML source and rejects the provisional JSON definition envelope", () => {
    const source = "steps:\n  - succeed:\n      message: Done\n";
    expect(validateWorkflowInputSchema.parse({ source })).toEqual({ source });
    expect(validateWorkflowInputSchema.safeParse({ source: "  \n" }).success).toBe(false);
    expect(validateWorkflowInputSchema.safeParse({ source, definition: { steps: [] } }).success).toBe(false);

    const created = createWorkflowInputSchema.parse({ name: "Route mail", source });
    expect(created).toMatchObject({ name: "Route mail", source, priority: 100 });
    expect(created.effectBudget.maxTargets).toBe(1_000);
    expect(created.effectBudget.maxAiCalls).toBe(10);
    expect(createWorkflowInputSchema.safeParse({ name: "Route mail", source, enabled: true }).success).toBe(false);
    expect(createWorkflowVersionInputSchema.safeParse({ name: "Not version metadata", source }).success).toBe(false);
  });

  test("keeps activation metadata outside YAML and trigger registrations inside it", () => {
    const expectedVersionId = "00000000-0000-4000-8000-000000000001";
    expect(activateWorkflowInputSchema.parse({ expectedVersionId })).toEqual({ expectedVersionId });
    expect(activateWorkflowInputSchema.safeParse({ expectedVersionId, triggers: [] }).success).toBe(false);
    expect(activateWorkflowInputSchema.safeParse({ expectedVersionId, enabled: true }).success).toBe(false);
    expect(deactivateWorkflowInputSchema.safeParse({ expectedVersionId }).success).toBe(true);
    expect(deactivateWorkflowInputSchema.safeParse({ expectedVersionId, reason: "legacy" }).success).toBe(false);
  });

  test("requires optimistic state for metadata updates and restore-as-new", () => {
    const expectedVersionId = "00000000-0000-4000-8000-000000000001";
    const expectedUpdatedAt = "2026-07-26T12:00:00.000Z";

    expect(updateWorkflowMetadataInputSchema.parse({ expectedUpdatedAt, name: "Renamed" })).toEqual({
      expectedUpdatedAt,
      name: "Renamed",
    });
    expect(updateWorkflowMetadataInputSchema.safeParse({ expectedUpdatedAt }).success).toBe(false);
    expect(updateWorkflowMetadataInputSchema.safeParse({ expectedUpdatedAt, priority: 1_001 }).success).toBe(false);
    expect(restoreWorkflowVersionInputSchema.parse({ expectedCurrentVersionId: expectedVersionId })).toEqual({
      expectedCurrentVersionId: expectedVersionId,
    });
    expect(restoreWorkflowVersionInputSchema.safeParse({ expectedCurrentVersionId: expectedVersionId, activate: true }).success).toBe(
      false,
    );
  });

  test("validates provider capability snapshots and defaults legacy quota evidence", () => {
    const legacy = {
      idle: true,
      condstore: true,
      qresync: false,
      move: true,
      uidplus: true,
      namespace: true,
      listExtended: true,
      specialUse: true,
      acl: false,
      notify: false,
      gmailExtensions: false,
    };
    expect(parseConnectorCapabilities(legacy)).toMatchObject({ idle: true, quota: false });
    expect(parseConnectorCapabilities({ ...legacy, idle: "yes" })).toMatchObject({ idle: false, quota: false });
  });
});
