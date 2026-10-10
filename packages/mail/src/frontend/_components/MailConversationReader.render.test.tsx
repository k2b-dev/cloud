import { describe, expect, test } from "bun:test";
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
      readingFormat: "automatic",
      theme: "light",
      calendarIntegrationAvailable: false,
      listCollapsed: false,
      detailsOpen: false,
      toolbarActions: options.toolbarActions ?? ["reply", "reply_all"],
      onRestoreList: () => undefined,
      onToggleDetails: () => undefined,
      onToolbarActionsChange: () => undefined,
      actionPending: false,
      onAction: () => undefined,
      onOpenHref: () => undefined,
      onManageTags: () => undefined,
      onMergeConversation: () => undefined,
      onReassignMessage: () => undefined,
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
  test("marks Reply when the conversation has a draft without rendering a header CTA", () => {
    const html = renderReader([draft]);

    expect(html).toContain('data-mail-toolbar-action="reply"');
    expect(html).toContain('aria-label="Reply, draft available"');
    expect(html).toContain("data-mail-draft-label");
    expect(html).toContain("sm:inline");
    expect(html).toContain("Draft available");
    expect(html).toContain("data-mail-draft-indicator");
    expect(html).toContain("sm:hidden");
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

    expect(retryHtml).toContain("Trying again · 2/5");
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

    expect(html).toContain('data-mail-toolbar-action="reply_all"');
    expect(html).toContain('aria-label="Reply all"');
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

  test("shows who kept the conversation and refuses Trash and Junk", () => {
    const html = renderReader([], { keep, toolbarActions: ["keep", "spam", "trash"] });
    expect(html).toContain("data-mail-kept-indicator");
    expect(html).toContain("Kept since");
    expect(html).toContain("Grace Hopper");
    expect(html).toContain(`aria-label="Kept conversations can't be deleted."`);
    expect(html).toContain(`aria-label="Kept conversations can't be moved to Junk."`);
    // Only people who manage the mailbox may stop keeping it.
    expect(html).not.toContain("Stop keeping");
  });

  test("lets mailbox managers stop keeping", () => {
    const html = renderReader([], { keep, canAdmin: true, toolbarActions: ["keep"] });
    expect(html).toContain('aria-label="Stop keeping"');
  });

  test("marks a message the server deleted while Cloud keeps it", () => {
    const html = renderReader([], { keep, messages: [{ ...message, deletedOnServer: true }] });
    expect(html).toContain("Deleted on the server, kept in Cloud");
  });
});
