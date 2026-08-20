import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { ConversationDraftSummary } from "../../contracts";
import type { ConversationCollaboration, ConversationComment, MailActivityEvent } from "../../service/collaboration";
import type { ConversationLocalTags, LocalTag } from "../../service/local-tags";
import type { MessageDetail } from "../../service/messages";
import type { ConversationPresenceParticipant } from "../../service/presence";
import type { MailDetailErrors } from "../../service/workspace";

const root = mkdtempSync(join(tmpdir(), "mail-detail-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailDetailsPanel } = await import("./MailDetailsPanel.tsx");

const now = "2026-08-09T10:00:00.000Z";
const mailboxId = "Box001";
const conversationId = "Conv01";

const draft: ConversationDraftSummary = {
  id: "Draft1",
  intent: "reply",
  subject: "Re: Quarterly review",
  bodyPreview: "Thanks for the update.",
  createdByDisplayName: "Valentin Kolb",
  updatedAt: now,
};

const tag: LocalTag = {
  id: "Tag001",
  mailboxId,
  name: "Important",
  color: "#2563eb",
  revision: 1,
  createdAt: now,
  updatedAt: now,
};

const collaboration: ConversationCollaboration = {
  conversationId,
  assignee: {
    id: "user-1",
    uid: "valentin",
    displayName: "Valentin Kolb",
    avatarHash: null,
  },
  workStatus: "needs_action",
  snoozedUntil: null,
  revision: 4,
};

const conversationTags: ConversationLocalTags = {
  conversationId,
  conversationRevision: collaboration.revision,
  tags: [tag],
};

const comment: ConversationComment = {
  id: "Comm01",
  conversationId,
  body: "**Check** the customer reply.",
  author: {
    kind: "user",
    id: "user-1",
    displayName: "Valentin Kolb",
    avatarHash: null,
  },
  referencedMessageId: null,
  revision: 1,
  canEdit: true,
  canDelete: true,
  editedAt: null,
  deletedAt: null,
  createdAt: now,
  updatedAt: now,
};

const deletedComment: ConversationComment = {
  ...comment,
  id: "CommDeleted",
  body: null,
  author: {
    kind: "user",
    id: "user-deleted",
    displayName: "Deleted Author",
    avatarHash: null,
  },
  revision: 2,
  canEdit: false,
  canDelete: false,
  deletedAt: "2026-08-09T10:05:00.000Z",
  updatedAt: "2026-08-09T10:05:00.000Z",
};

const activity: MailActivityEvent = {
  id: "00000000-0000-4000-8000-000000000005",
  conversationId,
  actor: {
    kind: "user",
    id: "user-1",
    displayName: "Valentin Kolb",
    avatarHash: null,
  },
  action: "conversation.status.changed",
  outcome: "confirmed",
  targetType: "conversation",
  targetId: conversationId,
  metadata: {},
  createdAt: now,
};

const presence: ConversationPresenceParticipant = {
  userId: "user-2",
  displayName: "Mara Klein",
  avatarHash: null,
  mode: "viewing",
  peerCount: 1,
  joinedAt: now,
};

const message: MessageDetail = {
  id: "Msg001",
  subject: "Quarterly review",
  messageId: "<quarterly-review@example.com>",
  internalDate: now,
  sentAt: now,
  from: [{ name: "Ada Lovelace", address: "ada@example.com" }],
  to: [{ name: "Support", address: "support@example.com" }],
  flags: [],
  keywords: [],
  hydrationStatus: "complete",
  remoteAvailable: true,
  folderId: "Fold01",
  contentType: "text/plain",
  sizeBytes: 4096,
  replyTo: [],
  cc: [],
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
  attachments: [
    {
      id: "Att001",
      filename: "review.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      contentId: null,
    },
  ],
};

const noDetailErrors: MailDetailErrors = {
  collaboration: null,
  tags: null,
  comments: null,
  assignableUsers: null,
  activity: null,
  reminder: null,
  reference: null,
  summary: null,
  drafts: null,
};

const renderPanel = (overrides: Partial<Parameters<typeof MailDetailsPanel>[0]> = {}) =>
  renderToString(() =>
    createComponent(MailDetailsPanel, {
      mailboxId,
      conversationId,
      active: false,
      canWrite: true,
      initialState: collaboration,
      initialLocalTags: [tag],
      initialConversationLocalTags: conversationTags,
      initialComments: [comment],
      initialCommentsCursor: null,
      assignableUsers: [{ ...collaboration.assignee!, permission: "admin", description: "Mailbox admin" }],
      presence: [presence],
      activity: [activity],
      initialReminder: null,
      detailErrors: noDetailErrors,
      conversationDrafts: [],
      messages: [message],
      subject: message.subject,
      requestUrl: `https://cloud.example.test/app/mail/${mailboxId}`,
      dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
      onCollaborationChange: () => {},
      onConversationTagsChange: () => {},
      onClose: () => {},
      onOpenHref: () => {},
      onReconcile: () => {},
      ...overrides,
    }),
  );

describe("Mail conversation detail panel", () => {
  test("can surface overview context and a full conversation destination", () => {
    const html = renderPanel({
      conversationHref: `/app/mail/${mailboxId}?conversation=${conversationId}`,
      conversationSummary: { summary: "Payment is due **Friday**.", summaryRevision: 2, conversationRevision: 5 },
    });

    expect(html).toContain("Conversation summary");
    expect(html).toContain("Payment is due");
    expect(html).toContain("<strong>Friday</strong>");
    expect(html).toContain(`href="/app/mail/${mailboxId}?conversation=${conversationId}"`);
    expect(html).toContain("Open conversation");
  });

  test("surfaces the newest conversation draft before workflow", () => {
    const html = renderPanel({
      conversationDrafts: [draft, { ...draft, id: "Draft2", createdByDisplayName: "Mara Klein" }],
    });

    expect(html).toContain("Drafts available");
    expect(html).toContain("Continue newest draft");
    expect(html).toContain("Created by Valentin Kolb · Updated");
    expect(html).toContain("/compose/Draft1?");
    expect(html).toContain('class="k2b-detail-panel__group" role="group" aria-label="Draft"');
    expect(html.indexOf("Drafts available")).toBeLessThan(html.indexOf(">Workflow<"));
  });

  test("composes the inspector from the shared grouped panel contract", () => {
    const html = renderPanel();
    const header = html.slice(0, html.indexOf('class="k2b-detail-panel__body"'));

    expect(html).toContain('class="k2b-detail-panel"');
    expect(html).toContain("<h2>Quarterly review</h2>");
    expect(header).toContain("Ada Lovelace");
    expect(header).not.toContain("1 message");
    expect(header).not.toContain("1 attachment");
    expect(header).toContain('class="k2b-detail-panel__meta"');
    expect(header).toContain("Needs action");
    expect(header).toContain('aria-label="Close conversation details"');
    expect(header).toContain("lg:hidden");
    expect(html).toContain('class="k2b-detail-panel__group" role="group" aria-label="Workflow"');
    expect(html).not.toContain(">Active collaborators<");
    expect(html).not.toContain("Here now");
    expect(html).toContain(">Tags<");
    expect(html).not.toContain("Next step");
    expect(html).toContain("Mark as done");
    expect(html).toContain('class="k2b-checkbox-card-field');
    expect(html.indexOf("Mark as done")).toBeLessThan(html.indexOf(">Workflow<"));
    expect(html).toContain('data-scroll-preserve="mail-conversation-detail"');
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Conversation context"');
    expect(html).toContain('aria-label="Conversation history"');
    expect(html).toContain('aria-label="Active collaborators" class="bg-[var(--ui-surface)] p-3"');
    expect(html).toContain('aria-label="Contacts" class="bg-[var(--ui-surface)] p-3"');
    expect(html).toContain('aria-label="Spaces" class="space-y-1 bg-[var(--ui-surface)] p-3"');
    expect(html).toContain("Related mail");
    expect(html).toContain("No related mail");
    expect(html.indexOf('aria-label="Active collaborators"')).toBeGreaterThan(html.indexOf('aria-label="Conversation context"'));
    expect(html.indexOf('aria-label="Active collaborators"')).toBeLessThan(html.indexOf('aria-label="Contacts"'));
    expect(html).not.toContain(">Contacts<");
    expect(html).not.toContain("border-t");
    expect(html).toContain('class="k2b-discussion');
    expect(html).toContain('class="k2b-discussion__item');
    expect(html).toContain('class="k2b-discussion__composer-inset-action"');
    expect(html).toContain('aria-label="Post comment"');
    const postButton = html.slice(html.indexOf('aria-label="Post comment"') - 180, html.indexOf('aria-label="Post comment"') + 220);
    expect(postButton).toContain("disabled");
    expect(postButton).toContain('data-variant="primary"');
    expect(html).not.toContain("Write a comment first.");
    expect(html).toContain('class="k2b-content-markdown');
    expect(html).toContain('href="/api/mail/mailboxes/Box001/messages/Msg001/attachments/Att001"');
    expect(html).toContain('download="review.pdf"');
    expect(html).toContain("Recent activity");
    expect(html).toContain("Mail details");
    expect(html.match(/<details class="k2b-detail-panel__section"/g)).toHaveLength(2);
    expect(html).toContain('data-visibility="progressive"');
    expect(html).not.toContain('data-visibility="always"');
    expect(html.indexOf('aria-label="Edit comment"')).toBeLessThan(html.indexOf('aria-label="Delete comment"'));
    expect(html).toContain('class="ti ti-pencil"');
    expect(html).not.toContain('aria-label="Reply to Valentin Kolb"');
    expect(html.slice(html.indexOf('aria-label="Edit comment"'), html.indexOf('aria-label="Edit comment"') + 220)).toContain(
      'data-size="xs"',
    );
    expect(html).not.toContain('class="detail-stack');
    expect(html).not.toContain('class="detail-section');
    expect(html).not.toContain("overflow-y-auto");
  });

  test("omits deleted comments from the visible discussion", () => {
    const html = renderPanel({ initialComments: [comment, deletedComment] });

    expect(html).toContain('class="k2b-discussion__count">1</span>');
    expect(html).toContain("Valentin Kolb");
    expect(html).not.toContain("Deleted Author");
    expect(html).not.toContain("Comment deleted");
  });

  test("keeps expired and workflow comments immutable with a workflow icon", () => {
    const html = renderPanel({
      canWrite: false,
      initialComments: [
        { ...comment, canEdit: false, canDelete: false },
        {
          ...comment,
          id: "CommWorkflow",
          author: { kind: "workflow", id: "workflow-1", displayName: "Workflow", avatarHash: null },
          canEdit: false,
          canDelete: false,
        },
      ],
    });
    const editIndex = html.indexOf('aria-label="Edit comment"');
    const deleteIndex = html.indexOf('aria-label="Delete comment"');

    expect(editIndex).toBe(-1);
    expect(deleteIndex).toBe(-1);
    expect(html).not.toContain("Reply to");
    expect(html).toContain('class="ti ti-route"');
    expect(html).toContain('aria-label="Create tag"');
    expect(html).toContain("disabled");
    expect(html).toContain('aria-label="Add internal comment"');
  });

  test("preserves partial-error and empty states without empty attachment shells", () => {
    const html = renderPanel({
      initialComments: [],
      presence: [],
      messages: [{ ...message, attachments: [] }],
      detailErrors: { ...noDetailErrors, tags: "Tags unavailable", activity: "Activity unavailable" },
    });

    expect(html).toContain("Some conversation details are temporarily unavailable");
    expect(html).toContain("Retry");
    expect(html).toContain('class="k2b-discussion__count">0</span>');
    expect(html).not.toContain("No team notes yet.");
    expect(html).toContain("Loading contacts...");
    expect(html).not.toContain(">Attachments<");
    expect(html).not.toContain(">Here now<");
  });
});
