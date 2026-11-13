import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ConversationDraftSummary } from "../../contracts";
import type { ConversationComment, MailActivityEvent } from "../../service/collaboration";
import type { ConversationKeep } from "../../service/conversation-keeps";
import type { LocalTag } from "../../service/local-tags";
import type { MessageDetail } from "../../service/messages";
import type { ConversationPresenceParticipant } from "../../service/presence";

const root = mkdtempSync(join(tmpdir(), "mail-conversation-reader-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailConversationReader } = await import("./MailConversationReader.tsx");

const now = "2026-08-16T12:00:00.000Z";
const message: MessageDetail = {
  id: "Msg001",
  subject: "Quarterly review",
  messageId: "<quarterly-review@example.com>",
  internalDate: now,
  sentAt: now,
  from: [{ name: "Ada Lovelace", address: "ada@example.com" }],
  to: [],
  preview: "Hello",
  hasAttachments: false,
  replyTo: [],
  cc: [],
  flags: [],
  keywords: [],
  hydrationStatus: "complete",
  remoteAvailable: true,
  folderId: "Fold01",
  contentType: "text/plain",
  sizeBytes: 5,
  plainText: "Hello",
  sanitizedHtml: null,
  forwardText: "Hello",
  selectedHeaders: {},
  sourceAvailable: true,
  mailingList: null,
  remoteContent: {
    imageIds: [],
    allowedByRule: false,
    allowRules: [],
    sender: "ada@example.com",
    domain: "example.com",
  },
  delivery: null,
  attachments: [],
  deletedOnServer: false,
};

const keep: ConversationKeep = {
  conversationId: "Conv01",
  canLift: false,
  keptAt: "2026-08-15T09:00:00.000Z",
  keptBy: { kind: "user", id: "user-1", displayName: "Grace Hopper", avatarHash: null },
};

const draft: ConversationDraftSummary = {
  id: "Draft1",
  intent: "reply",
  subject: "Re: Quarterly review",
  bodyPreview: "Thanks for the update.",
  suggestion: false,
  createdByDisplayName: "Valentin Kolb",
  updatedAt: now,
};

const renderReader = (
  conversationDrafts: ConversationDraftSummary[],
  options: {
    messages?: MessageDetail[];
    activity?: MailActivityEvent[];
    selectedMessageId?: string | null;
    keep?: ConversationKeep | null;
    canAdmin?: boolean;
    canWrite?: boolean;
    tags?: LocalTag[];
    comments?: ConversationComment[];
    presence?: ConversationPresenceParticipant[];
    readingFormat?: "automatic" | "html" | "plain";
    theme?: "light" | "dark" | null;
    workStatus?: "needs_action" | "waiting" | "done" | null;
    assignment?: { assigned: boolean; others: string[] } | null;
    replyPosition?: "top" | "bottom";
  } = {},
) => {
  const messages = options.messages ?? [message];
  return renderToString(() =>
    createComponent(MailConversationReader, {
      currentUserId: "Usr001",
      mailboxId: "Box001",
      requestUrl: "https://cloud.example.test/app/mail/Box001?conversation=Conv01",
      canWrite: options.canWrite ?? true,
      canAdmin: options.canAdmin ?? false,
      mailboxWide: true,
      identities: [],
      onOpenDeliverySettings: () => undefined,
      selectionKey: "Conv01",
      selectedConversationId: "Conv01",
      selectedMessageId: options.selectedMessageId ?? null,
      unread: false,
      flagged: false,
      inJunk: false,
      keep: options.keep ?? null,
      reference: null,
      subject: message.subject,
      messages,
      activity: options.activity ?? [],
      conversationSummary: null,
      conversationDrafts,
      totalMessageCount: messages.length,
      error: null,
      dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
      readingFormat: options.readingFormat ?? "automatic",
      theme: options.theme === undefined ? "light" : options.theme,
      calendarIntegrationAvailable: false,
      collaboration: null,
      reminder: null,
      assignableUsers: [],
      onCollaborationChange: () => undefined,
      tags: options.tags ?? [],
      comments: options.comments ?? [],
      commentsCursor: null,
      detailErrors: {
        collaboration: null,
        tags: null,
        comments: null,
        assignableUsers: null,
        activity: null,
        reminder: null,
        keep: null,
        reference: null,
        summary: null,
        drafts: null,
      },
      presence: options.presence ?? [],
      hintSeen: (hint) => hint === "reader-head-moved",
      toolbarCustomized: false,
      onHintSeen: () => undefined,
      actionPending: false,
      structurePending: false,
      onAction: () => undefined,
      onOpenHref: () => undefined,
      onManageTags: () => undefined,
      onMergeConversation: () => undefined,
      onReassignMessage: () => undefined,
      automationTrace: [],
      onUndoAutomation: () => undefined,
      onAssignConversation: () => undefined,
      onAssignConversationToMe: () => undefined,
      assignment: options.assignment ?? null,
      workStatus: options.workStatus ?? null,
      completionPending: false,
      onSetCompletion: () => undefined,
      respondRequest: null,
      onRespondRequestHandled: () => undefined,
      onSplitMessage: () => undefined,
      onKeep: () => undefined,
      onStopKeeping: () => undefined,
      onSummarySaved: async () => undefined,
      onReconcile: async () => undefined,
      onReconcileAfterWrite: async () => undefined,
      onClose: () => undefined,
      // Most tests here were written for the box under the conversation; "the reply box on top" covers the default.
      replyPosition: options.replyPosition ?? "bottom",
    }),
  );
};

describe("Mail conversation reader", () => {
  test("leaves conversations and empty readers to the shell print fallback until prepared", () => {
    setSystemTime(new Date(now));
    try {
      expect(renderReader([])).not.toContain("data-print-region");
      expect(renderReader([], { messages: [] })).not.toContain("data-print-region");
    } finally {
      setSystemTime();
    }
  });
  test("renders one HTML body with a whitespace-only alternative in every theme", () => {
    for (const theme of [null, "light", "dark"] as const) {
      for (const plainText of ["\n", " ", "\t\n "]) {
        const html = renderReader([], { messages: [{ ...message, sanitizedHtml: "<p>Hello</p>", plainText }], theme });
        expect(html).toContain('class="contents" data-mail-body-format="html"');
        expect(html).not.toContain('data-mail-body-format="plain"');
        expect(html.match(/data-mail-body-format=/g)).toHaveLength(1);
        expect(html).not.toContain("View as plain text");
      }
    }
  });

  test("renders a pending body as loading, never as the wait the browser starts after its request", () => {
    const html = renderReader([], { messages: [{ ...message, hydrationStatus: "envelope", plainText: null, sanitizedHtml: null }] });
    expect(html).toContain("data-mail-body-state");
    expect(html).toContain('data-state="loading"');
    expect(html).toContain("Body is still synchronizing");
    expect(html).toContain("Mail loads it from the mailbox first.");
    expect(html).not.toContain("data-mail-body-waiting");
    expect(html).not.toContain("Waiting for the mailbox");
  });

  test("renders a failed body as an error with its retry", () => {
    const html = renderReader([], { messages: [{ ...message, hydrationStatus: "failed", plainText: null, sanitizedHtml: null }] });
    expect(html).toContain('data-state="error"');
    expect(html).toContain("The message body could not be synchronized");
    expect(html).toContain("Try again");
  });

  test("Automatic shows only HTML in dark mode even when real plain text exists", () => {
    const html = renderReader([], { messages: [{ ...message, sanitizedHtml: "<p>Hello</p>" }], theme: "dark" });
    expect(html).toContain('class="contents" data-mail-body-format="html"');
    expect(html).not.toContain('data-mail-body-format="plain"');
    expect(html.match(/data-mail-body-format=/g)).toHaveLength(1);
    expect(html).toContain("Show original colors");
  });

  test("the plain reading preference shows only the plain alternative", () => {
    const html = renderReader([], { messages: [{ ...message, sanitizedHtml: "<p>Hello</p>" }], theme: "dark", readingFormat: "plain" });
    expect(html).toContain('class="contents" data-mail-body-format="plain"');
    expect(html).not.toContain('data-mail-body-format="html"');
    expect(html).not.toContain("Show original colors");
  });

  test("offers adaptation for original HTML colors in dark mode", () => {
    const html = renderReader([], {
      messages: [{ ...message, plainText: null, sanitizedHtml: "<p>Hello</p>" }],
      theme: "dark",
      readingFormat: "html",
    });
    expect(html).toContain("Adapt colors to dark mode");
    expect(html).not.toContain("View as plain text");
  });

  test("the reply box stands open under the newest message, without a pill, draft rows, or a Continue dialog", () => {
    const html = renderReader([draft]);
    const box = html.indexOf('data-mail-reply-box="pending"');
    expect(box).toBeGreaterThan(html.indexOf('data-mail-message-id="Msg001"'));
    // The server renders the box's placeholder at its height; the browser loads the draft into it.
    expect(html).toContain("mail-reply-box-skeleton");
    expect(html).not.toContain("data-mail-reply-pill");
    expect(html).not.toContain("data-mail-draft-row");
    expect(html).not.toContain("Continue draft");
  });

  test("keeps Reply unmarked when the conversation has no draft", () => {
    const html = renderReader([]);

    expect(html).toContain('aria-label="Reply"');
    expect(html).not.toContain('data-mail-toolbar-action="reply_all"');
    expect(html).not.toContain("Reply all");
    expect(html).not.toContain("data-mail-draft-label");
    expect(html).not.toContain("data-mail-draft-indicator");
  });

  test("uses the compact shared button for an undo-window delivery", () => {
    const html = renderReader([], {
      messages: [
        {
          ...message,
          delivery: {
            submissionId: "Delivery01",
            draftId: "Draft01",
            state: "undo_window",
            attempt: 0,
            maxAttempts: 5,
            scheduledAt: "2099-08-16T12:00:00.000Z",
            undoUntil: "2099-08-16T12:00:10.000Z",
            acceptedAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            acceptedRecipients: [],
            rejectedRecipients: [],
          },
        },
      ],
    });

    expect(html).toMatch(/<button[^>]*data-mail-undo-send[^>]*class="k2b-button /);
    expect(html).toContain('data-size="xs"');
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain("data-mail-undo-send");
    expect(html).not.toContain("mail-delivery-action-badge");
  });

  test("renders retry and partial-send states as compact visible controls", () => {
    const delivery = {
      submissionId: "Delivery02",
      draftId: "Draft02",
      state: "scheduled" as const,
      attempt: 2,
      maxAttempts: 5,
      scheduledAt: "2099-08-16T12:01:00.000Z",
      undoUntil: null,
      acceptedAt: null,
      lastErrorCode: "SMTP_TRANSIENT_REJECTION",
      lastErrorMessage: "Temporary rejection",
      acceptedRecipients: [],
      rejectedRecipients: [],
    };
    const retryHtml = renderReader([], { messages: [{ ...message, delivery }] });
    const partialHtml = renderReader([], {
      messages: [
        {
          ...message,
          delivery: {
            ...delivery,
            state: "needs_attention",
            lastErrorCode: "SMTP_PARTIAL_ACCEPTANCE",
            acceptedRecipients: ["accepted@example.com"],
            rejectedRecipients: ["rejected@example.com"],
          },
        },
      ],
    });

    expect(retryHtml).toContain("Trying again");
    expect(retryHtml).not.toContain("Trying again · 2/5");
    expect(retryHtml).toContain('data-variant="warning"');
    expect(partialHtml).toContain("Partially sent");
  });

  test("renders a terminal send failure as a compact red control", () => {
    const html = renderReader([], {
      messages: [
        {
          ...message,
          delivery: {
            submissionId: "Delivery03",
            draftId: "Draft03",
            state: "failed",
            attempt: 5,
            maxAttempts: 5,
            scheduledAt: "2099-08-16T12:01:00.000Z",
            undoUntil: null,
            acceptedAt: null,
            lastErrorCode: "EENVELOPE",
            lastErrorMessage: "Recipient rejected",
            acceptedRecipients: [],
            rejectedRecipients: ["rejected@example.com"],
          },
        },
      ],
    });

    expect(html).toContain("Couldn’t send");
    expect(html).toContain('data-variant="danger"');
  });

  test("the head holds Done, Archive, Delete, Later, Assign and “…”; the pill after the newest message only answers", () => {
    const groupMessage = { ...message, cc: [{ name: "Stakeholder", address: "stakeholder@example.com" }] };
    const html = renderReader([], {
      messages: [groupMessage],
      workStatus: "needs_action",
      assignment: { assigned: false, others: ["Jana Berger"] },
    });
    const head = html.slice(html.indexOf("data-mail-reader-toolbar"), html.indexOf("data-mail-reader-chips"));
    expect([...head.matchAll(/data-mail-toolbar-action="([^"]+)"/g)].map((match) => match[1])).toEqual([
      "done",
      "archive",
      "trash",
      "later",
      "assign",
    ]);
    expect(head).toContain(">Done<");
    expect(head).toContain('aria-label="More conversation actions"');
    // No personal toolbar and no details toggle any more (Mail v5).
    expect(html).not.toContain("data-mail-details-trigger");
    expect(html).not.toContain("mail-reader-toolbar-action");
    // The reply box follows the newest message at the end of the conversation.
    expect(html.indexOf("data-mail-reply-box")).toBeGreaterThan(html.indexOf('data-mail-message-id="Msg001"'));
  });
  test("a personal mailbox has no Assign in the head", () => {
    const html = renderReader([], { workStatus: "needs_action", assignment: null });
    expect(html).not.toContain('data-mail-toolbar-action="assign"');
    expect(html).toContain('data-mail-toolbar-action="done"');
  });

  test("the subject stays on one line and the chip row names the sender and the number of messages", () => {
    const older = { ...message, id: "MsgOld", internalDate: "2026-08-16T11:00:00.000Z", sentAt: "2026-08-16T11:00:00.000Z" };
    const html = renderReader([], { messages: [older, message] });
    expect(html).toMatch(/<h1[^>]*class="mail-reader-title"[^>]*title="Quarterly review"/);
    expect(html).toContain("Ada Lovelace · 2 messages");
  });
  test("reads oldest first: older messages are one line, the newest is open at the bottom", () => {
    const older = { ...message, id: "MsgOld", internalDate: "2026-08-16T11:00:00.000Z", sentAt: "2026-08-16T11:00:00.000Z" };
    const html = renderReader([], { messages: [older, message] });
    expect(html.indexOf('data-mail-message-id="MsgOld"')).toBeLessThan(html.indexOf('data-mail-message-id="Msg001"'));
    const olderStart = html.lastIndexOf("<article", html.indexOf('data-mail-message-id="MsgOld"'));
    const olderArticle = html.slice(olderStart, html.indexOf("</article>", olderStart));
    expect(olderArticle).toContain('class="mail-message-row"');
    expect(olderArticle).toContain('aria-expanded="false"');
    const newestStart = html.lastIndexOf("<article", html.indexOf('data-mail-message-id="Msg001"'));
    const newest = html.slice(newestStart, html.indexOf("</article>", newestStart));
    expect(newest).toContain('class="mail-message-head"');
    expect(newest).toContain("data-mail-sender-trigger");
    // A link to an older message opens that one instead.
    const linked = renderReader([], { messages: [older, message], selectedMessageId: older.id });
    const linkedOlder = linked.slice(linked.lastIndexOf("<article", linked.indexOf('data-mail-message-id="MsgOld"')));
    expect(linkedOlder.slice(0, linkedOlder.indexOf("</article>"))).toContain('class="mail-message-head"');
  });

  test("a long conversation folds its older messages into one row above the newest three", () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      ...message,
      id: `Msg00${index}`,
      internalDate: `2026-08-16T0${index}:00:00.000Z`,
      sentAt: `2026-08-16T0${index}:00:00.000Z`,
    }));
    const html = renderReader([], { messages });
    expect(html).toContain("data-mail-older-messages");
    expect(html).toContain("3 older messages");
    expect(html.indexOf("data-mail-older-messages")).toBeLessThan(html.indexOf('data-mail-message-id="Msg003"'));
    expect(html).not.toContain('data-mail-message-id="Msg002"');
  });
  test("shows a message's attachments as tiles after its body and their count in every collapsed row", () => {
    /** Invented demo attachments: one image the HTML body shows in place, four photos, and a PDF. */
    const attachment = (id: string, filename: string, contentType: string, contentId: string | null = null) => ({
      id,
      filename,
      contentType,
      sizeBytes: 120_000,
      contentId,
      checksum: null,
    });
    const withFiles: MessageDetail = {
      ...message,
      hasAttachments: true,
      sanitizedHtml: '<p>Photos from the summer party</p><img src="cid:logo@example.com">',
      attachments: [
        attachment("Att001", "logo.png", "image/png", "<logo@example.com>"),
        attachment("Att002", "Programme.pdf", "application/pdf"),
        ...["Att003", "Att004", "Att005", "Att006"].map((id, index) => attachment(id, `Photo_${index + 1}.jpg`, "image/jpeg")),
      ],
    };
    const older = { ...withFiles, id: "MsgOld", internalDate: "2026-08-16T11:00:00.000Z", sentAt: "2026-08-16T11:00:00.000Z" };
    const html = renderReader([], { messages: [older, withFiles], readingFormat: "html" });
    const latestStart = html.lastIndexOf("<article", html.indexOf('data-mail-message-id="Msg001"'));
    const latest = html.slice(latestStart, html.indexOf("</article>", latestStart));
    const olderStart = html.lastIndexOf("<article", html.indexOf('data-mail-message-id="MsgOld"'));
    const olderArticle = html.slice(olderStart, html.indexOf("</article>", olderStart));

    // The tiles follow the body and leave out the image the body already shows.
    const tiles = latest.indexOf("data-mail-message-attachments");
    expect(tiles).toBeGreaterThan(latest.indexOf("mail-message-body"));
    expect(latest).toContain('aria-label="5 attachments"');
    expect(latest).not.toContain("logo.png");
    // Every tile shows its name and its kind with the size, never the MIME type; from two on, all download as one ZIP.
    for (const name of ["Programme.pdf", "Photo_1.jpg", "Photo_4.jpg"]) expect(latest).toContain(name);
    expect(latest).toContain("PDF · ");
    expect(latest).not.toContain("application/pdf");
    expect(latest).toContain("Download all 5");
    expect(latest).not.toContain("Show all");
    // A collapsed message names its attachments in its one line, without the tiles.
    expect(olderArticle).toContain('aria-expanded="false"');
    expect(olderArticle).toContain("data-mail-message-attachment-count");
    expect(olderArticle).not.toContain("data-mail-message-attachments");
    // The plain alternative shows no inline image, so the image is a tile there.
    expect(renderReader([], { messages: [{ ...withFiles, plainText: "Photos" }], readingFormat: "plain" })).toContain(
      'aria-label="6 attachments"',
    );
  });
  test("keeps activity out of the timeline; it waits under “…” → Show activity", () => {
    const html = renderReader([], {
      activity: [
        {
          id: "10",
          conversationId: "Conv01",
          actor: { kind: "workflow", id: "Workflow01", displayName: "Invoice triage", avatarHash: null },
          action: "conversation.local_tag_added",
          outcome: "confirmed",
          targetType: "local_tag",
          targetId: "Tag001",
          metadata: {},
          createdAt: "2026-08-16T12:01:00.000Z",
          conversationSubject: null,
          assignees: null,
        },
      ],
    });
    expect(html).not.toContain("data-mail-conversation-activity");
    expect(html).not.toContain("added a tag");
    expect(html.match(/<article class="mail-message/g)).toHaveLength(1);
  });

  test("shows internal notes at their time between the messages, never as a message", () => {
    const older = { ...message, id: "MsgOld", internalDate: "2026-08-16T09:00:00.000Z", sentAt: "2026-08-16T09:00:00.000Z" };
    const note = {
      id: "Note01",
      conversationId: "Conv01",
      body: "Oak is tight until week 48.",
      author: { kind: "user" as const, id: "Usr002", displayName: "Tom Behrens", avatarHash: null },
      referencedMessageId: null,
      revision: 1,
      canEdit: true,
      canDelete: true,
      editedAt: null,
      deletedAt: null,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:00:00.000Z",
    };
    const deleted = { ...note, id: "Note02", body: null, deletedAt: "2026-08-16T11:30:00.000Z", createdAt: "2026-08-16T11:00:00.000Z" };
    const html = renderReader([], { messages: [older, message], comments: [deleted, note] });
    const order = ['data-mail-message-id="MsgOld"', 'data-mail-note="Note01"', 'data-mail-note="Note02"', 'data-mail-message-id="Msg001"'];
    const positions = order.map((marker) => html.indexOf(marker));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    const tile = html.slice(
      html.indexOf('data-mail-note="Note01"') - 40,
      html.indexOf("</article>", html.indexOf('data-mail-note="Note01"')),
    );
    expect(tile).toContain('class="mail-note"');
    expect(tile).toContain("Internal note from Tom Behrens");
    expect(tile).toContain(">internal<");
    expect(tile).toContain("Oak is tight until week 48.");
    expect(tile).not.toContain("k2b-avatar");
    expect(html).toContain("Note from Tom Behrens deleted");
  });
});

describe("Mail conversation reader with the reply box on top", () => {
  const note = {
    id: "Note01",
    conversationId: "Conv01",
    body: "Oak is tight until week 48.",
    author: { kind: "user" as const, id: "Usr002", displayName: "Tom Behrens", avatarHash: null },
    referencedMessageId: null,
    revision: 1,
    canEdit: true,
    canDelete: true,
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
  };
  const at = (id: string, hour: string): MessageDetail => ({
    ...message,
    id,
    internalDate: `2026-08-16T${hour}:00:00.000Z`,
    sentAt: `2026-08-16T${hour}:00:00.000Z`,
  });

  test("the server renders the box first, then the newest message open, then older messages and notes newest first", () => {
    const html = renderReader([draft], { messages: [at("MsgOld", "09"), message], comments: [note], replyPosition: "top" });
    const order = [
      'data-mail-reply-box="pending"',
      'data-mail-message-id="Msg001"',
      'data-mail-note="Note01"',
      'data-mail-message-id="MsgOld"',
    ];
    const positions = order.map((marker) => html.indexOf(marker));
    expect(positions.every((position) => position > 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
    expect(html).toContain('data-reply-position="top"');
    const newestStart = html.lastIndexOf("<article", html.indexOf('data-mail-message-id="Msg001"'));
    expect(html.slice(newestStart, html.indexOf("</article>", newestStart))).toContain('class="mail-message-head"');
  });

  test("a long conversation folds its older messages into one row below the newest three", () => {
    const messages = ["00", "01", "02", "03", "04", "05"].map((hour, index) => at(`Msg00${index}`, hour));
    const html = renderReader([], { messages, replyPosition: "top" });
    expect(html).toContain("3 older messages");
    expect(html.indexOf('data-mail-message-id="Msg005"')).toBeLessThan(html.indexOf('data-mail-message-id="Msg003"'));
    expect(html.indexOf('data-mail-message-id="Msg003"')).toBeLessThan(html.indexOf("data-mail-older-messages"));
    expect(html).not.toContain('data-mail-message-id="Msg002"');
  });

  test("a person who cannot write sees the conversation newest first and no box", () => {
    const html = renderReader([], { messages: [at("MsgOld", "09"), message], canWrite: false, replyPosition: "top" });
    expect(html).not.toContain("data-mail-reply-box");
    expect(html.indexOf('data-mail-message-id="Msg001"')).toBeLessThan(html.indexOf('data-mail-message-id="MsgOld"'));
  });
});

describe("Mail conversation reader keep state", () => {
  test("a conversation that is not kept has no Kept chip and Delete stays available", () => {
    const html = renderReader([]);
    expect(html).not.toContain('data-mail-head-chip="kept"');
    const trash = html.match(/<button[^>]*data-mail-toolbar-action="trash"[^>]*>/)?.[0] ?? "";
    expect(trash).toContain('aria-label="Delete"');
    expect(trash).not.toContain("disabled");
  });
  test("shows who kept the conversation, refuses Delete, and locks it for everyone but Cloud administrators", () => {
    // A mailbox manager is no Cloud administrator: the chip explains who can lift it, and no dead action is offered.
    const html = renderReader([], { keep, canAdmin: true });
    const chip = html.slice(
      html.indexOf('data-mail-head-chip="kept"') - 80,
      html.indexOf("</span></span>", html.indexOf('data-mail-head-chip="kept"')),
    );
    expect(chip).toContain("<span");
    expect(chip).toContain("Kept");
    expect(chip).toContain("Kept since");
    expect(chip).toContain("Grace Hopper");
    expect(chip).toContain("Only a Cloud administrator can lift this.");
    // The visible name leads the reason in Delete's accessible name.
    expect(html).toContain(`aria-label="Delete: Kept conversations can't be deleted."`);
    expect(html).not.toContain("Stop keeping");
  });
  test("lets Cloud administrators stop keeping from the Kept chip", () => {
    const html = renderReader([], { keep: { ...keep, canLift: true } });
    expect(html).toMatch(/<button[^>]*data-mail-head-chip="kept"/);
    expect(html).not.toContain("Only a Cloud administrator can lift this.");
  });

  test("names the conversation's state, tags and read-only access as chips under the subject", () => {
    const html = renderReader([], {
      workStatus: "waiting",
      canWrite: false,
      tags: [{ id: "Tag001", mailboxId: "Box001", name: "Offer", color: "#0f766e", revision: 1, createdAt: now, updatedAt: now }],
    });
    const chips = html.slice(html.indexOf("data-mail-reader-chips"));
    const ids = [...chips.matchAll(/data-mail-head-chip="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toEqual(["waiting", "read-only", "tag:Tag001"]);
    expect(chips).toContain("Waiting for reply");
    expect(chips).toContain("Read only");
    expect(chips).toContain("Offer");
    // Without write access, nothing in the head changes the conversation.
    expect(html).not.toContain('data-mail-toolbar-action="done"');
    expect(html).not.toContain('data-mail-toolbar-action="archive"');
    expect(chips).not.toContain('aria-label="Add tag"');
  });

  test("names who else reads the conversation, never the viewer", () => {
    const person = (userId: string, displayName: string) => ({
      userId,
      displayName,
      avatarHash: null,
      mode: "viewing" as const,
      peerCount: 1,
      joinedAt: now,
    });
    const html = renderReader([], { presence: [person("Usr001", "Valentin Kolb"), person("Usr002", "Tom Behrens")] });
    expect(html).toContain("Tom is reading");
    expect(html).not.toContain("Valentin is reading");
  });
  test("marks a message the server deleted while Cloud keeps it", () => {
    const html = renderReader([], { keep, messages: [{ ...message, deletedOnServer: true }] });
    expect(html).toContain("Deleted on the server, kept in Cloud");
  });
});
