import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { MailListItem } from "./mail-navigation";

const root = mkdtempSync(join(tmpdir(), "mail-conversation-row-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailConversationRow } = await import("./MailConversationRow.tsx");

const item: MailListItem = {
  id: "Msg001",
  conversationId: "Conv01",
  selectionKind: "conversation",
  primaryReference: null,
  subject: "Project Atlas",
  participantSummary: "Ada",
  participantLabels: ["Ada"],
  latestMessageAt: "2026-08-19T10:00:00.000Z",
  preview: "Message preview",
  attachmentMatch: {
    attachmentId: "Att001",
    messageId: "Msg002",
    filename: "roadmap.pdf",
    snippet: "Matched roadmap milestone",
    reason: "attachment_content",
  },
  unread: false,
  activeFolderIds: [],
  flagged: false,
  hasAttachments: true,
  messageCount: 1,
  workStatus: "needs_action",
  assigneeUserId: null,
  snoozedUntil: null,
  sourceFolderId: null,
  unreadFolderIds: [],
  localTags: [],
  revision: 1,
  kept: false,
};

const renderRow = (value: MailListItem) =>
  renderToString(() =>
    createComponent(MailConversationRow, {
      item: value,
      requestUrl: new URL("https://cloud.example/app/mail/Box001?q=roadmap"),
      state: {
        selectedConversationId: null,
        selectedMessageId: null,
        selectedConversationIds: new Set<string>(),
        selectionMode: false,
        canWrite: false,
        spamAction: "junk",
        dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
      },
      actions: {
        navigate: () => {},
        toggleSelection: () => {},
        itemAction: () => {},
        manageTags: () => {},
        merge: () => {},
      },
    }),
  );

describe("Mail conversation attachment match row", () => {
  test("renders a file-specific accessible download link", () => {
    const html = renderRow(item);

    expect(html).toContain('href="/api/mail/mailboxes/Box001/messages/Msg002/attachments/Att001"');
    expect(html).toContain('aria-label="Download matched attachment roadmap.pdf"');
    expect(html).toContain('<span class="sr-only">Download matched attachment roadmap.pdf</span>');
  });

  test("omits the download action without an attachment match", () => {
    expect(renderRow({ ...item, attachmentMatch: null })).not.toContain("Download matched attachment");
  });
});

describe("Mail conversation kept marker", () => {
  test("marks a kept conversation with an accessible lock", () => {
    const html = renderRow({ ...item, kept: true });
    expect(html).toContain("data-mail-kept-indicator");
    expect(html).toContain('aria-label="Kept conversation"');
    expect(html).toContain("ti ti-lock");
  });

  test("leaves other conversations unmarked", () => {
    expect(renderRow(item)).not.toContain("data-mail-kept-indicator");
  });
});
