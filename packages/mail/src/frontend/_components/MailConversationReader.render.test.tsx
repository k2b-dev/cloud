import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ConversationDraftSummary } from "../../contracts";
import type { MailActivityEvent } from "../../service/collaboration";
import type { ConversationKeep } from "../../service/conversation-keeps";
import type { MessageDetail } from "../../service/messages";

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
    toolbarActions?: Array<"reply" | "reply_all" | "trash" | "spam" | "keep">;
    readingFormat?: "automatic" | "html" | "plain";
    theme?: "light" | "dark" | null;
    workStatus?: "needs_action" | "waiting" | "done" | null;
    assignment?: { assigned: boolean; others: string[] } | null;
  } = {},
) => {
  const messages = options.messages ?? [message];
  return renderToString(() =>
    createComponent(MailConversationReader, {
      mailboxId: "Box001",
      requestUrl: "https://cloud.example.test/app/mail/Box001?conversation=Conv01",
      canWrite: true,
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
      listAway: false,
      detailsOpen: false,
      toolbarActions: options.toolbarActions ?? ["reply", "reply_all"],
      onToggleDetails: () => undefined,
      onToolbarActionsChange: () => undefined,
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

  test("marks Reply in the pill when the conversation has a draft without rendering a header CTA", () => {
    const html = renderReader([draft]);

    expect(html).toContain("data-mail-reply-pill");
    expect(html).toContain('data-mail-toolbar-action="reply"');
    expect(html).toContain('aria-label="Reply, draft available"');
    expect(html).toContain("data-mail-draft-indicator");
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

  test("shows Reply all when it adds an original recipient", () => {
    const groupMessage = {
      ...message,
      cc: [{ name: "Stakeholder", address: "stakeholder@example.com" }],
    };
    const html = renderReader([], { messages: [groupMessage] });

    // Reply all is a pill action with its label while the row has room.
    expect(html).toContain('aria-label="Reply all"');
    expect(html).toMatch(/class="k2b-toolbar__text"[^>]*>Reply all</);
  });

  test("the pill holds Reply, Reply all, Forward | Done, Assign in a shared mailbox and no Archive", () => {
    const groupMessage = { ...message, cc: [{ name: "Stakeholder", address: "stakeholder@example.com" }] };
    const html = renderReader([], {
      messages: [groupMessage],
      workStatus: "needs_action",
      assignment: { assigned: false, others: ["Jana Berger"] },
    });
    const pill = html.slice(html.indexOf("data-mail-reply-pill"), html.indexOf("data-mail-conversation-messages"));
    const names = [...pill.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(names.filter((name) => name !== "More actions" && name !== "Conversation actions")).toEqual([
      "Reply",
      "Reply all",
      "Forward",
      "Mark as done",
      "Assign",
    ]);
    expect(pill).not.toContain("Archive");
    // The head names who is responsible as a status chip, not a button.
    expect(html).toContain("mail-reader-assignees");
    expect(html).toContain("Jana Berger");
  });

  test("the pill has four buttons in a personal mailbox", () => {
    const groupMessage = { ...message, cc: [{ name: "Stakeholder", address: "stakeholder@example.com" }] };
    const html = renderReader([], { messages: [groupMessage], workStatus: "needs_action", assignment: null });
    const pill = html.slice(html.indexOf("data-mail-reply-pill"), html.indexOf("data-mail-conversation-messages"));
    expect(pill).not.toContain('aria-label="Assign"');
    expect(html).not.toContain("mail-reader-assignees");
  });

  test("keeps an expanded older message body outside the muted header surface", () => {
    const older = { ...message, id: "MsgOld", internalDate: "2026-08-16T11:00:00.000Z", sentAt: "2026-08-16T11:00:00.000Z" };
    const html = renderReader([], { messages: [older, message], selectedMessageId: older.id });
    const articleStart = html.lastIndexOf("<article", html.indexOf('data-mail-message-id="MsgOld"'));
    const articleEnd = html.indexOf("</article>", articleStart);
    const olderArticle = html.slice(articleStart, articleEnd);
    const articleOpen = olderArticle.slice(0, olderArticle.indexOf(">") + 1);

    expect(articleOpen).not.toContain("bg-[var(--ui-surface-subtle)]");
    expect(olderArticle).toContain(
      'class="flex items-start gap-1 rounded-[var(--ui-radius-surface)] p-1 transition-colors bg-[var(--ui-surface-subtle)]',
    );
    expect(olderArticle).toContain('aria-expanded="true"');
  });

  test("shows a message's attachments above its body and their count in every message header", () => {
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

    // The list sits between the header and the body and leaves out the image the body already shows.
    const list = latest.indexOf("data-mail-message-attachments");
    expect(list).toBeGreaterThan(latest.indexOf("data-mail-message-header"));
    expect(list).toBeLessThan(latest.indexOf("mail-message-body"));
    expect(latest).toContain("5 attachments");
    expect(latest).not.toContain("logo.png");
    // The first three, then "Show all 5"; images get a preview, other files their type, never the MIME type.
    expect(latest).toContain("Programme.pdf");
    expect(latest).toContain("Photo_2.jpg");
    expect(latest).not.toContain("Photo_3.jpg");
    expect(latest).toContain("Show all 5");
    expect(latest).toContain('src="/api/mail/mailboxes/Box001/messages/Msg001/attachments/Att003?inline=true"');
    expect(latest).not.toContain("application/pdf");
    // A collapsed message names its attachments in its header, without the list.
    expect(olderArticle).toContain('aria-expanded="false"');
    expect(olderArticle).toContain("data-mail-message-attachment-count");
    expect(olderArticle).not.toContain("data-mail-message-attachments");
    // Open, the list says it; the header repeats nothing.
    expect(latest).not.toContain("data-mail-message-attachment-count");
    // The plain alternative shows no inline image, so the image is listed there.
    expect(renderReader([], { messages: [{ ...withFiles, plainText: "Photos" }], readingFormat: "plain" })).toContain("6 attachments");
  });

  test("renders meaningful SSR activity inline without turning it into a message card", () => {
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

    expect(html).toContain("data-mail-conversation-activity");
    expect(html).toContain("ti-tag");
    expect(html).toContain("Workflow Invoice triage");
    expect(html).toContain("added a tag");
    expect(html.match(/<article/g)).toHaveLength(1);
  });
});

describe("Mail conversation reader keep state", () => {
  test("offers Keep to writers of a conversation that is not kept", () => {
    const html = renderReader([], { toolbarActions: ["keep", "trash"] });
    expect(html).toContain('data-mail-toolbar-action="keep"');
    expect(html).toContain('aria-label="Keep"');
    expect(html).not.toContain("data-mail-kept-indicator");
  });

  test("shows who kept the conversation, refuses Trash and Junk, and locks it for everyone but Cloud administrators", () => {
    // A mailbox manager is no Cloud administrator: the lock explains who can lift it, and no dead action is offered.
    const html = renderReader([], { keep, canAdmin: true, toolbarActions: ["keep", "spam", "trash"] });
    expect(html).toContain("data-mail-kept-indicator");
    expect(html).toContain("Kept since");
    expect(html).toContain("Grace Hopper");
    expect(html).toContain("Only a Cloud administrator can lift this.");
    // The bar's short name leads the reason, so the visible "Trash" is part of the accessible name.
    expect(html).toContain(`aria-label="Trash: Kept conversations can't be deleted."`);
    expect(html).toContain(`aria-label="Kept conversations can't be moved to Junk."`);
    expect(html).not.toContain("Stop keeping");
    // The chosen toolbar slot stays as a locked status, so nothing moves.
    expect(html).toMatch(/data-mail-toolbar-action="keep"[^>]*disabled|disabled[^>]*data-mail-toolbar-action="keep"/);
  });

  test("lets Cloud administrators stop keeping", () => {
    const html = renderReader([], { keep: { ...keep, canLift: true }, toolbarActions: ["keep"] });
    expect(html).toContain('aria-label="Stop keeping"');
    expect(html).not.toContain("Only a Cloud administrator can lift this.");
  });

  test("marks a message the server deleted while Cloud keeps it", () => {
    const html = renderReader([], { keep, messages: [{ ...message, deletedOnServer: true }] });
    expect(html).toContain("Deleted on the server, kept in Cloud");
  });
});
