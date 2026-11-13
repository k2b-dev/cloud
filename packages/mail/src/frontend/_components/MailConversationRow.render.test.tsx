import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { MailListItem } from "./mail-navigation";
import type { MailRowAssignee } from "./mail-row-assignees";

const root = mkdtempSync(join(tmpdir(), "mail-conversation-row-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailConversationRow } = await import("./MailConversationRow.tsx");

const item: MailListItem = {
  drafts: { count: 0, editors: [] },
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
  attachmentCount: 2,
  messageCount: 1,
  workStatus: "needs_action",
  assigneeUserIds: [],
  snoozedUntil: null,
  sourceFolderId: null,
  unreadFolderIds: [],
  localTags: [],
  revision: 1,
  kept: false,
};

const renderRow = (
  value: MailListItem,
  assignees: MailRowAssignee[] | null = null,
  currentUserId: string | null = null,
  canWrite = false,
) =>
  renderToString(() =>
    createComponent(MailConversationRow, {
      item: value,
      assignees,
      requestUrl: new URL("https://cloud.example/app/mail/Box001?q=roadmap"),
      state: {
        selectedConversationId: null,
        selectedMessageId: null,
        selectedConversationIds: new Set<string>(),
        selectionMode: false,
        canWrite,
        spamAction: "junk",
        currentUserId,
        dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
      },
      actions: {
        navigate: () => {},
        toggleSelection: () => {},
        itemAction: () => {},
        manageTags: () => {},
        respond: () => {},
        assigneeNames: () => [],
        setCompletion: () => {},
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

describe("Mail conversation row marks (v5)", () => {
  const plain = { ...item, attachmentMatch: null, attachmentCount: undefined };

  test("one row for both densities: no line count, the date in the row, the checkbox for writers", () => {
    const html = renderRow(plain, null, null, true);
    expect(html).not.toContain("data-lines");
    expect(html).toContain('class="mail-row-time-cell"');
    expect(html).toContain('aria-label="Select Project Atlas"');
    expect(html).toContain('aria-pressed="false"');
    expect(renderRow(plain)).not.toContain("mail-list-checkbox");
  });

  test("a draft says Draft beside the sender and names who writes it", () => {
    const html = renderRow({
      ...plain,
      drafts: { count: 1, editors: [{ id: "11111111-1111-4111-8111-111111111111", kind: "user", displayName: "Tom Behrens" }] },
    });
    expect(html).toContain('aria-label="Draft: Tom Behrens"');
    expect(html).toMatch(/data-mail-row-draft[^>]*>Draft</);
    expect(html).not.toContain("data-suggestion");
  });

  test("an untouched suggestion is ✦ Suggestion and names its account", () => {
    const html = renderRow({ ...plain, drafts: { count: 1, editors: [], suggestedBy: "Gustav" } });
    expect(html).toContain("data-suggestion");
    expect(html).toContain('aria-label="Suggestion from Gustav"');
    expect(html).toContain("ti ti-sparkles");
  });

  test("Waiting stands as a word, Later as a clock with its day, and the message count after the sender", () => {
    // Wednesday, 19 August 2026, 12:00 UTC.
    setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
    try {
      const html = renderRow({
        ...plain,
        workStatus: "waiting",
        messageCount: 3,
        // Two days ahead of now: its weekday.
        snoozedUntil: "2026-08-21T12:00:00.000Z",
      });
      expect(html).toContain(">Waiting<");
      expect(html).toMatch(/class="mail-row-snooze"[^>]*aria-label="until Fri"/);
      expect(html).toContain('aria-label="3 messages"');
      // A snooze that has passed shows nothing.
      expect(renderRow({ ...plain, snoozedUntil: "2026-08-19T11:59:00.000Z" })).not.toContain("mail-row-snooze");
    } finally {
      setSystemTime();
    }
  });

  test("who is responsible: one face, you first as You, everyone in the label", () => {
    const html = renderRow(
      plain,
      [
        { id: "u2", name: "Nora Example" },
        { id: "u1", name: "Robin Example" },
      ],
      "u1",
    );
    expect(html).toContain('aria-label="Responsible: You, Nora Example"');
    expect(html).toContain("+1");
    expect(renderRow(plain, [])).not.toContain("data-mail-assignees");
    expect(renderRow(plain, [{ id: "u9", name: "Someone", unknown: true }])).toContain('aria-label="Responsible: Someone"');
  });

  test("the snooze day is the weekday within six days and the date after", async () => {
    const { mailRowSnoozeDay } = await import("./MailConversationRow.tsx");
    const now = new Date("2026-11-12T09:00:00Z");
    // ICU data differ in the abbreviation's dot ("Fr." in browsers, "Fr" in some runtimes).
    expect(mailRowSnoozeDay("2026-11-13T07:00:00Z", now, "de", "Europe/Berlin")).toMatch(/^Fr\.?$/);
    expect(mailRowSnoozeDay("2026-11-13T07:00:00Z", now, "en", "Europe/Berlin")).toBe("Fri");
    expect(mailRowSnoozeDay("2026-11-30T07:00:00Z", now, "de", "Europe/Berlin")).toBe("30.11.");
  });
});
