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
import { summaryState } from "./mail-summary-fixtures";

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
  assignees: [
    {
      id: "user-1",
      uid: "valentin",
      displayName: "Valentin Kolb",
      avatarHash: null,
    },
  ],
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
  conversationSubject: null,
  assignees: null,
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
  preview: "Hello",
  hasAttachments: true,
  flags: [],
  keywords: [],
  hydrationStatus: "complete",
  remoteAvailable: true,
  folderId: "Fold01",
  deletedOnServer: false,
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
      checksum: null,
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
  keep: null,
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
      mailboxWide: true,
      initialState: collaboration,
      initialLocalTags: [tag],
      initialConversationLocalTags: conversationTags,
      initialComments: [comment],
      initialCommentsCursor: null,
      assignableUsers: [{ ...collaboration.assignees[0]!, permission: "admin", scope: "mailbox", description: "Mailbox admin" }],
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

const between = (html: string, from: string, to: string) => html.slice(html.indexOf(from), html.indexOf(to));

describe("Mail conversation detail panel", () => {
  test("follows the shared outline: header, here now, properties, notes, linked, attachments, then More about", () => {
    const html = renderPanel();
    const order = [
      'class="k2b-detail-panel__kind"',
      ">Here now<",
      ">Properties<",
      ">Team notes<",
      ">Linked<",
      ">Attachments<",
      ">More about this conversation<",
      ">People<",
      ">Activity<",
      ">Technical details<",
    ].map((marker) => html.indexOf(marker));
    for (const index of order) expect(index).toBeGreaterThan(-1);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    // Every section carries its icon (UI-27), and there are no boxes.
    for (const icon of ["ti-users", "ti-list-details", "ti-message-circle", "ti-arrows-exchange", "ti-paperclip", "ti-activity"])
      expect(html).toContain(`ti ${icon}`);
    expect(html).not.toContain("bg-[var(--ui-surface)] p-3");
    expect(html).not.toContain("k2b-checkbox-card");
    expect(html.match(/k2b-detail-panel__body/g)).toHaveLength(1);
    expect(html).toContain('data-scroll-preserve="mail-conversation-detail"');
  });

  test("the header names the conversation, its state, and offers Mark as done with more actions", () => {
    const html = renderPanel({ conversationHref: `/app/mail/${mailboxId}?conversation=${conversationId}` });
    const header = html.slice(0, html.indexOf('class="k2b-detail-panel__body"'));
    expect(header).toContain(">Conversation<");
    expect(header).toContain("Needs action");
    expect(header).toContain("<h2>Quarterly review</h2>");
    expect(header).toContain("Ada Lovelace · 1 message · latest");
    expect(header).toContain("Mark as done");
    expect(header).toContain('aria-label="More actions"');
    expect(header).toContain('aria-label="Close conversation details"');
    expect(header).toContain("@min-[64rem]/k2b-app-area:hidden");
    // Who is here moved from the header's avatar stack to "Here now" at the top of the body.
    expect(header).not.toContain("k2b-avatar-stack");
    expect(between(html, ">Here now<", ">Properties<")).toContain("Mara");
    expect(header).not.toContain("Read only");
  });

  test("properties are quiet rows that open their pickers, with the reminder marked as personal", () => {
    const html = renderPanel();
    const properties = between(html, ">Properties<", ">Linked<");
    for (const term of ["Assigned", "Tags", "Show later", "Reminder"]) expect(properties).toContain(`>${term}<`);
    expect(properties).toContain('data-appearance="plain"');
    expect(properties).toContain("only for you");
    expect(properties).toContain("Not planned");
    expect(properties).toContain("Not set");
    expect(properties).toContain('aria-label="Create tag"');
  });

  test("an AI summary carries ✦ AI, a person's summary stays neutral", () => {
    const ai = renderPanel({
      conversationSummary: summaryState({ summary: "Payment is due **Friday**.", summaryRevision: 2, conversationRevision: 5 }),
    });
    expect(ai).toContain("<strong>Friday</strong>");
    expect(ai.indexOf("Payment is due")).toBeLessThan(ai.indexOf(">Properties<"));
    const aiSummary = summaryState({ summary: "Payment is due.", summaryRevision: 2, conversationRevision: 5 });
    if (aiSummary?.ai) expect(ai).toContain("✦ AI");
    const person = renderPanel({
      conversationSummary: aiSummary ? { ...aiSummary, ai: false } : aiSummary,
    });
    expect(person).not.toContain("✦");
  });

  test("surfaces the newest conversation draft before the properties", () => {
    const html = renderPanel({
      conversationDrafts: [draft, { ...draft, id: "Draft2", createdByDisplayName: "Mara Klein" }],
    });

    expect(html).toContain("Drafts available");
    expect(html).toContain("Continue newest draft");
    expect(html).toContain("Created by Valentin Kolb · Updated");
    expect(html).toContain("/compose/Draft1?");
    expect(html.indexOf("Drafts available")).toBeLessThan(html.indexOf(">Properties<"));
  });

  test("attachments show their kind and size, a preview button, and download and save in their slot", () => {
    const html = renderPanel();
    const attachments = between(html, ">Attachments<", ">More about this conversation<");
    expect(attachments).toContain("PDF · 2 KB");
    expect(attachments).not.toContain("application/pdf");
    expect(attachments).toContain('class="k2b-file-grid__open"');
    expect(attachments).toContain('data-action-visibility="progressive"');
    expect(attachments).toContain('href="/api/mail/mailboxes/Box001/messages/Msg001/attachments/Att001"');
    expect(attachments).toContain('download="review.pdf"');
    expect(attachments).toContain('aria-label="Save review.pdf to…"');
    expect(attachments).not.toContain("ti-paperclip");
  });

  test("the same file in two messages is one row; the same name with other content names its sender", () => {
    const pdf = message.attachments[0]!;
    const html = renderPanel({
      messages: [
        { ...message, id: "Msg001", attachments: [{ ...pdf, id: "Att001", checksum: "aa" }] },
        {
          ...message,
          id: "Msg002",
          from: [{ name: "Mara Klein", address: "mara@example.com" }],
          attachments: [
            { ...pdf, id: "Att002", checksum: "aa" },
            {
              ...pdf,
              id: "Att003",
              filename: "budget.xlsx",
              contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              checksum: "bb",
            },
          ],
        },
        {
          ...message,
          id: "Msg003",
          attachments: [
            {
              ...pdf,
              id: "Att004",
              filename: "budget.xlsx",
              contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              checksum: "cc",
            },
          ],
        },
      ],
    });
    const attachments = between(html, ">Attachments<", ">More about this conversation<");
    expect(attachments.match(/class="k2b-file-grid__open"/g)).toHaveLength(3);
    expect(attachments).toContain("PDF · 2 KB · in 2 messages");
    expect(attachments).toContain("Spreadsheet · 2 KB · from Mara Klein");
    expect(attachments).toContain("Spreadsheet · 2 KB · from Ada Lovelace");
  });

  test("omits deleted comments from the visible discussion", () => {
    const html = renderPanel({ initialComments: [comment, deletedComment] });
    expect(html).toContain("Valentin Kolb");
    expect(html).not.toContain("Deleted Author");
  });

  test("read only: a lock badge, no Mark as done, and properties that cannot open", () => {
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
    const header = html.slice(0, html.indexOf('class="k2b-detail-panel__body"'));
    expect(header).toContain("Read only");
    expect(header).toContain("you can only read");
    expect(header).not.toContain("Mark as done");
    expect(html).not.toContain('aria-label="Edit comment"');
    expect(html).not.toContain('aria-label="Delete comment"');
    expect(html).toContain('class="ti ti-route"');
    expect(html).not.toContain('aria-label="Create tag"');
    expect(html).not.toContain("Create task in Spaces");
    expect(between(html, ">Properties<", ">Linked<")).toContain("disabled");
  });

  test("empty and partly failed: one quiet line per section, each failure with its retry where it happened", () => {
    const html = renderPanel({
      initialComments: [],
      presence: [],
      activity: [],
      messages: [{ ...message, attachments: [] }],
      detailErrors: { ...noDetailErrors, tags: "Tags unavailable", activity: "Activity unavailable", keep: "Keep unavailable" },
    });
    expect(between(html, ">Properties<", ">Linked<")).toContain("Some properties can");
    expect(between(html, ">Attachments<", ">More about this conversation<")).toContain("No attachments");
    expect(html).toContain('class="k2b-section__none">None yet</span>');
    expect(between(html, ">Activity<", ">Technical details<")).toContain("Activity can");
    // A failure outside the outline's sections stays one line above them.
    expect(html.indexOf("keep")).toBeLessThan(html.indexOf(">Properties<"));
    expect(html).toContain('data-state="error"');
    expect(html).toContain("Try again");
  });
});

describe("Mail detail panel: who is here and who has access", () => {
  const members = [
    { principal: { type: "user" as const, userId: "user-1" }, permission: "admin" as const, displayName: "Ada Lovelace" },
    {
      principal: { type: "user" as const, userId: "user-2" },
      permission: "write" as const,
      displayName: "Mara Klein",
      scope: "assigned" as const,
    },
  ];
  const more = (html: string) => html.slice(html.indexOf(">More about this conversation<"));
  const access = (overrides: Partial<NonNullable<Parameters<typeof MailDetailsPanel>[0]["access"]>> = {}) => ({
    members,
    state: "ready" as const,
    load: () => {},
    retry: () => {},
    ...overrides,
  });

  test("mailbox-wide readers see who has access first under More about; assigned-only access is part of the role", () => {
    const html = more(renderPanel({ access: access(), currentUserId: "user-1" }));
    expect(html.indexOf(">Access<")).toBeLessThan(html.indexOf(">People<"));
    expect(html).toMatch(/>Access<\/span>[\s\S]*>You, Mara Klein</);
    expect(html).toContain("Edit · Assigned only");
    expect(html).toContain("Applies to the whole mailbox.");
    expect(html).not.toContain("Manage access");
    expect(more(renderPanel({ access: access({ manage: () => {} }) }))).toContain("Manage access");
  });

  test("people who see only assigned conversations get no access section; loading and failure keep its place", () => {
    expect(renderPanel({ access: null })).not.toContain(">Access<");
    expect(more(renderPanel({ access: access({ members: [], state: "loading" }) }))).toContain("Loading who has access");
    expect(more(renderPanel({ access: access({ members: [], state: "error" }) }))).toMatch(
      /Could not load who has access[\s\S]*>Try again</,
    );
  });

  test("Here now stands first in every state, also for a viewer who is alone", () => {
    const shared = [
      { ...collaboration.assignees[0]!, permission: "admin" as const, scope: "mailbox" as const, description: "Admin" },
      {
        ...collaboration.assignees[0]!,
        id: "user-3",
        displayName: "Lin Park",
        permission: "write" as const,
        scope: "mailbox" as const,
        description: "",
      },
    ];
    expect(renderPanel({ presence: [], assignableUsers: shared, presenceState: "loading" })).toContain("Loading who is here");
    expect(renderPanel({ presence: [], assignableUsers: shared, presenceState: "unavailable", onRetryPresence: () => {} })).toMatch(
      />Here now<[\s\S]*Try again/,
    );
    // Alone it says so, in the same two lines, so nothing moves when someone else opens the conversation.
    expect(renderPanel({ presence: [], assignableUsers: shared.slice(0, 1), currentUserId: shared[0]!.id })).toMatch(
      />Here now<[\s\S]*Only you[\s\S]*Whoever opens this conversation appears here\./,
    );
  });
});
