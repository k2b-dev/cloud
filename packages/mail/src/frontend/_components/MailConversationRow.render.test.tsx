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

const renderRow = (value: MailListItem, columns?: { assignees: string[] | null }) =>
  renderToString(() =>
    createComponent(MailConversationRow, {
      item: value,
      ...(columns ? { columns } : {}),
      requestUrl: new URL("https://cloud.example/app/mail/Box001?q=roadmap"),
      state: {
        selectedConversationId: null,
        selectedMessageId: null,
        selectedConversationIds: new Set<string>(),
        selectionMode: false,
        canWrite: false,
        spamAction: "junk",
        currentUserId: null,
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

describe("Mail conversation participants column", () => {
  const team = [
    "Lea Brandt",
    "Tom Keller",
    "Anna Roth",
    "Ben Fischer",
    "Clara Hoff",
    "David Lang",
    "Eva Pohl",
    "Finn Braun",
    "Greta Vogel",
  ];
  const cell = (html: string) => html.slice(html.indexOf("mail-row-participants-cell"), html.indexOf("mail-row-assignee-cell"));
  const faces = (html: string) => cell(html).match(/class="k2b-avatar "/g)?.length ?? 0;

  test("one person: the sender the row names stands alone, gray, with no +n", () => {
    const html = renderRow({ ...item, attachmentMatch: null }, { assignees: [] });
    expect(faces(html)).toBe(1);
    expect(cell(html)).toContain('aria-label="1 participant · External: Ada"');
    expect(cell(html)).not.toContain("k2b-avatar-stack__more");
    expect(cell(html)).not.toContain("data-tint");
  });

  test("nobody the reader can see wrote: the column stays empty instead of guessing a sender", () => {
    const html = renderRow({ ...item, attachmentMatch: null, participantLabels: [] }, { assignees: [] });
    expect(cell(html)).not.toContain("data-mail-participants");
  });

  test("three people: three faces, team members tinted, external gray", () => {
    const html = renderRow(
      {
        ...item,
        attachmentMatch: null,
        participants: [{ name: "Petra Albers" }, { name: "Jonas Weber", kind: "user" }, { name: "Mira Schulz", kind: "user" }],
      },
      { assignees: [] },
    );
    expect(faces(html)).toBe(3);
    expect(cell(html)).not.toContain("k2b-avatar-stack__more");
    expect(cell(html)).toContain('aria-label="3 participants · External: Petra Albers · Team: Jonas Weber, Mira Schulz"');
    expect(cell(html).match(/data-tint=/g)?.length).toBe(2);
  });

  test("seventeen people: three faces, then +14, and the tooltip names the listed ten and the rest", () => {
    const html = renderRow(
      {
        ...item,
        attachmentMatch: null,
        participants: [{ name: "Sabine Jahn" }, ...team.map((name) => ({ name, kind: "user" as const }))],
        participantCount: 17,
      },
      { assignees: [] },
    );
    expect(faces(html)).toBe(3);
    expect(cell(html)).toContain(">+14</span>");
    expect(cell(html)).toContain(`aria-label="17 participants · External: Sabine Jahn · Team: ${team.join(", ")} and 7 more"`);
  });

  test("an automation that wrote is square with a robot and named as one", () => {
    const html = renderRow(
      {
        ...item,
        attachmentMatch: null,
        participants: [{ name: "Ada" }, { name: "Invoices", kind: "workflow" }],
      },
      { assignees: [] },
    );
    expect(cell(html)).toContain('data-shape="square"');
    expect(cell(html)).toContain("ti ti-robot");
    expect(cell(html)).toContain("Automations: Invoices");
  });

  test("the three-line row leaves the column out", () => {
    expect(renderRow(item)).not.toContain("mail-row-participants-cell");
  });
});
