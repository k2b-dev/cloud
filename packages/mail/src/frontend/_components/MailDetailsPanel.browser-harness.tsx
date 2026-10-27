import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { ConversationCollaboration, ConversationComment, MailActivityEvent } from "../../service/collaboration";
import type { ConversationLocalTags, LocalTag } from "../../service/local-tags";
import type { MessageDetail } from "../../service/messages";
import type { MailDetailErrors } from "../../service/workspace";
import { mailWorkspaceMessages } from "../mail-workspace-messages";
import MailDetailsPanel, { MailDetailsSkeleton } from "./MailDetailsPanel";
import { summaryState } from "./mail-summary-fixtures";

/** The real details panel with invented data; the test serves the context, related mail, and attachments. */
export type MailDetailsHarnessState = "normal" | "many" | "empty" | "loading" | "error" | "readonly";

declare global {
  interface Window {
    mountDetails: (state: MailDetailsHarnessState) => void;
  }
}

const now = "2026-10-27T09:40:00.000Z";
const ago = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();
const person = (id: string, displayName: string) => ({ id, uid: id, displayName, avatarHash: null });
const lena = person("user-lena", "Lena Hoffmann");
const jonas = person("user-jonas", "Jonas Weber");

const attachment = (id: string, filename: string, sizeBytes: number, checksum: string) => ({
  id,
  filename,
  contentType: filename.endsWith(".pdf")
    ? "application/pdf"
    : filename.endsWith(".jpg")
      ? "image/jpeg"
      : filename.endsWith(".xlsx")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : filename.endsWith(".zip")
          ? "application/zip"
          : "application/octet-stream",
  sizeBytes: Math.round(sizeBytes),
  contentId: null,
  checksum,
});
const kb = 1024;
const mb = 1024 * 1024;
const message = (id: string, name: string, address: string, minutes: number, attachments: MessageDetail["attachments"]): MessageDetail => ({
  id,
  subject: "Freigabe Broschüre",
  messageId: `<${id}@nordlicht-druck.example>`,
  internalDate: ago(minutes),
  sentAt: ago(minutes),
  from: [{ name, address }],
  to: [{ name: "Vertrieb", address: "vertrieb@messe-team.example" }],
  preview: null,
  hasAttachments: attachments.length > 0,
  flags: [],
  keywords: [],
  hydrationStatus: "complete",
  remoteAvailable: true,
  folderId: "Fold01",
  deletedOnServer: false,
  contentType: "multipart/mixed",
  sizeBytes: 64 * kb,
  replyTo: [],
  cc: [],
  plainText: "Hallo",
  sanitizedHtml: null,
  forwardText: "",
  selectedHeaders: {},
  sourceAvailable: true,
  mailingList: null,
  remoteContent: { imageIds: [], allowedByRule: false, sender: null, domain: null },
  delivery: null,
  attachments,
});
const few = [
  message("Msg001", "Lena Hoffmann", "lena@messe-team.example", 17 * 60, [attachment("Att01", "Kalkulation-Druck.xlsx", 64 * kb, "k1")]),
  message("Msg002", "Druckerei Nordlicht", "kai@nordlicht-druck.example", 25, [
    attachment("Att02", "Broschüre-v3.pdf", 4.2 * mb, "b3"),
    attachment("Att03", "Seite-4-neu.jpg", 1.8 * mb, "s4"),
    attachment("Att04", "Seite-7-neu.jpg", 2 * mb, "s7"),
  ]),
  message("Msg003", "Mira Okafor", "mira@messe-team.example", 0, [attachment("Att05", "Broschüre-v3.pdf", 4.2 * mb, "b3")]),
];
const many = [
  message("Msg001", "Lena Hoffmann", "lena@messe-team.example", 17 * 60, [
    attachment("Att01", "Broschüre-v2.pdf", 3.9 * mb, "b2"),
    attachment("Att02", "Kalkulation-Druck.xlsx", 64 * kb, "k1"),
    attachment("Att03", "Farbprofil.icc", 12 * kb, "icc"),
  ]),
  message("Msg002", "Druckerei Nordlicht", "kai@nordlicht-druck.example", 25, [
    attachment("Att04", "Broschüre-v3.pdf", 4.2 * mb, "b3"),
    attachment("Att05", "Druckdaten.zip", 48 * mb, "zip"),
    attachment("Att06", "Kalkulation-Druck.xlsx", 64 * kb, "k2"),
    attachment("Att07", "Seite-4-neu.jpg", 1.8 * mb, "s4"),
    attachment("Att08", "Seite-7-neu.jpg", 2 * mb, "s7"),
  ]),
  message("Msg003", "Mira Okafor", "mira@messe-team.example", 0, [
    attachment("Att09", "Broschüre-v3.pdf", 4.2 * mb, "b3"),
    attachment("Att10", "Druckdaten.zip", 48 * mb, "zip"),
    attachment("Att11", "Seite-4-neu.jpg", 1.8 * mb, "s4"),
    attachment("Att12", "Seite-7-neu.jpg", 2 * mb, "s7"),
    ...Array.from({ length: 9 }, (_, index) => attachment(`Att${20 + index}`, `Aufbau-0${index + 1}.jpg`, 2.4 * mb, `a${index}`)),
  ]),
];

const tags: LocalTag[] = [
  { id: "Tag01", mailboxId: "Box001", name: "Druck", color: "#a16207", revision: 1, createdAt: now, updatedAt: now },
  { id: "Tag02", mailboxId: "Box001", name: "Kunde", color: "#1d4ed8", revision: 1, createdAt: now, updatedAt: now },
];
const comment = (id: string, author: typeof lena, body: string, minutes: number): ConversationComment => ({
  id,
  conversationId: "Conv01",
  body,
  author: { kind: "user", ...author },
  referencedMessageId: null,
  revision: 1,
  canEdit: false,
  canDelete: false,
  editedAt: null,
  deletedAt: null,
  createdAt: ago(minutes),
  updatedAt: ago(minutes),
});
const event = (id: string, action: string, minutes: number): MailActivityEvent => ({
  id,
  conversationId: "Conv01",
  actor: { kind: "user", ...lena },
  action,
  outcome: "confirmed",
  targetType: "conversation",
  targetId: "Conv01",
  metadata: {},
  createdAt: ago(minutes),
});
const noErrors: MailDetailErrors = {
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

window.mountDetails = (state) => {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing harness root");
  const empty = state === "empty";
  const collaboration: ConversationCollaboration = {
    conversationId: "Conv01",
    assignees: empty ? [] : [lena],
    workStatus: "needs_action",
    snoozedUntil: null,
    revision: 4,
  };
  const conversationTags: ConversationLocalTags = { conversationId: "Conv01", conversationRevision: 4, tags: empty ? [] : tags };
  render(
    () => (
      <LocaleProvider locale="de">
        {state === "loading" ? (
          <MailDetailsSkeleton label={mailWorkspaceMessages.resolve(["de"]).t.loadingDetails} />
        ) : (
          <MailDetailsPanel
            mailboxId="Box001"
            conversationId="Conv01"
            active
            canWrite={state !== "readonly"}
            mailboxWide
            initialState={collaboration}
            initialLocalTags={tags}
            initialConversationLocalTags={conversationTags}
            initialComments={
              empty
                ? []
                : [
                    comment("Com01", jonas, "Seite 7: Bildrechte sind geklärt.", 120),
                    comment("Com02", lena, "Ich gebe bis Mittag frei.", 40),
                  ]
            }
            initialCommentsCursor={null}
            assignableUsers={[
              { ...lena, permission: "write", scope: "mailbox", description: "Vertrieb" },
              { ...jonas, permission: "write", scope: "mailbox", description: "Vertrieb" },
            ]}
            presence={[]}
            currentUserId="user-lena"
            activity={
              empty
                ? [event("00000000-0000-4000-8000-000000000001", "conversation.comment_created", 20)]
                : [
                    event("00000000-0000-4000-8000-000000000001", "conversation.comment_created", 20),
                    event("00000000-0000-4000-8000-000000000002", "conversation.local_tag_added", 25),
                    event("00000000-0000-4000-8000-000000000003", "conversation.summary_updated", 26),
                    event("00000000-0000-4000-8000-000000000004", "draft.created", 17 * 60),
                  ]
            }
            initialReminder={
              empty
                ? null
                : {
                    id: "Rem01",
                    conversationId: "Conv01",
                    userId: "user-lena",
                    dueAt: "2026-10-29T08:00:00.000Z",
                    state: "pending",
                    revision: 1,
                    createdAt: now,
                    updatedAt: now,
                  }
            }
            detailErrors={noErrors}
            conversationDrafts={[]}
            messages={empty ? [message("Msg001", "Paul Kremer", "paul@kremer-messebau.example", 30, [])] : state === "many" ? many : few}
            subject={empty ? "Anfrage Standfläche" : "Freigabe Broschüre"}
            requestUrl="https://cloud.example.test/app/mail/Box001?conversation=Conv01"
            dateConfig={{ locale: "de", timeZone: "Europe/Berlin" }}
            conversationSummary={
              empty
                ? null
                : summaryState({
                    summary: "Die Druckerei braucht die Freigabe bis Donnerstag, sonst verschiebt sich die Lieferung vom 6. November.",
                    source: "workflow",
                    ai: true,
                  })
            }
            onCollaborationChange={() => {}}
            onConversationTagsChange={() => {}}
            onClose={() => {}}
            onOpenHref={() => {}}
            onReconcile={() => {}}
          />
        )}
      </LocaleProvider>
    ),
    host,
  );
  // The workspace's details column gives its panel the plain surface; the harness stands in for that column.
  host.querySelector(".k2b-detail-panel")?.setAttribute("data-surface", "plain");
};
