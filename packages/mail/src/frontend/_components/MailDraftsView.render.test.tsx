import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { DraftFolderItem, DraftFolderPage } from "../../contracts";
import { mailTestRow } from "./mail-list-test-fixtures";

const root = mkdtempSync(join(tmpdir(), "mail-drafts-view-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailDraftsView } = await import("./MailDraftsView.tsx");
const { default: MailConversationRow } = await import("./MailConversationRow.tsx");

const dateConfig = { timeZone: "UTC", locale: "en" };

const draft = (overrides: Partial<DraftFolderItem> = {}): DraftFolderItem => ({
  id: "Drf001",
  conversationId: null,
  intent: "new",
  subject: "Quarterly figures",
  to: [{ name: "Ada Example", address: "ada@example.test" }],
  cc: [{ name: null, address: "team@example.test" }],
  bcc: [],
  revision: 4,
  attachmentCount: 1,
  bodyPreview: "Here are the numbers.",
  suggestion: false,
  createdByDisplayName: "Mail provider",
  updatedAt: "2026-10-01T09:00:00.000Z",
  ...overrides,
});

const render = (page: DraftFolderPage, options: { canWrite?: boolean; columns?: boolean } = {}) =>
  renderToString(() =>
    createComponent(MailDraftsView, {
      mailboxId: "Box001",
      canWrite: options.canWrite ?? true,
      title: "Drafts",
      returnHref: "/app/mail/Box001?folder=Fld001&cursor=old",
      page,
      error: null,
      dateConfig,
      loading: false,
      columns: options.columns ?? false,
      onNavigate: () => undefined,
      onRefresh: async () => undefined,
    }),
  );

const conversation = (columns: boolean) =>
  renderToString(() =>
    createComponent(MailConversationRow, {
      item: mailTestRow("Conv01", {
        unread: false,
        subject: "Quarterly figures",
        preview: "Here are the numbers.",
        participantLabels: ["Ada Example", "team@example.test"],
        attachmentCount: 1,
        // The columns view's sender cell has room for a count; the draft's "+1" more recipients takes it.
        messageCount: columns ? 2 : 1,
      }),
      ...(columns ? { columns: { assignees: null } } : {}),
      requestUrl: new URL("https://cloud.example/app/mail/Box001"),
      state: {
        selectedConversationId: null,
        selectedMessageId: null,
        selectedConversationIds: new Set<string>(),
        selectionMode: false,
        canWrite: true,
        spamAction: "junk",
        currentUserId: null,
        dateConfig,
      },
      actions: {
        navigate: () => {},
        toggleSelection: () => {},
        itemAction: () => {},
        manageTags: () => {},
        respond: () => {},
        assigneeNames: () => [],
        setCompletion: () => {},
      },
    }),
  );

/** The row's layout classes in document order: the parts that decide its lines, columns and widths. */
const skeleton = (html: string) =>
  [...html.matchAll(/class="([^"]*)"/g)]
    .flatMap((match) => match[1]!.split(/\s+/))
    .filter((name) =>
      /^mail-(list-entry|list-row|list-preview|row-(dot|lines|from|sender|time|subject-line|subject|marks|mark|cells|cell|more|count)$)/.test(
        name,
      ),
    );

describe("MailDraftsView", () => {
  test("draws a draft as a conversation row: recipients where the sender is, the orange Draft tag, then the subject", () => {
    const html = render({ items: [draft()], nextCursor: "next", total: 3 });
    expect(skeleton(html)).toEqual(skeleton(conversation(false)));
    expect(html).toContain('data-lines="3"');
    expect(html).toMatch(/<h1[^>]*class="sr-only"[^>]*>Drafts<\/h1>/);
    expect(html).toContain('role="list"');
    expect(html).toContain('href="/app/mail/Box001/compose/Drf001?return=%2Fapp%2Fmail%2FBox001%3Ffolder%3DFld001"');
    expect(html).toMatch(/class="mail-row-sender"[^>]*>Ada Example</);
    expect(html).toContain("+1");
    expect(html).toMatch(
      /class="mail-row-subject-line"[^>]*><span class="mail-row-tag mail-row-draft-tag"[^>]*>Draft<\/span><span class="mail-row-subject"[^>]*>Quarterly figures</,
    );
    expect(html).toContain("--mail-tag:var(--color-orange-500)");
    expect(html).toContain('aria-label="1 attachment"');
    expect(html).toMatch(/class="mail-list-preview"[^>]*>Here are the numbers\.</);
    expect(html).toContain('<span class="sr-only">Started by Mail provider</span>');
    expect(html).toContain('aria-keyshortcuts="Delete"');
    expect(html).toContain('aria-label="Actions for Quarterly figures"');
    expect(html).toContain('href="/app/mail/Box001?folder=Fld001&amp;cursor=next"');
  });

  test("draws the columns view as the conversations' one line, with who started the draft", () => {
    const html = render({ items: [draft()], nextCursor: null, total: 1 }, { columns: true });
    expect(skeleton(html)).toEqual(skeleton(conversation(true)));
    expect(html).toContain('data-lines="1"');
    expect(html).toContain("mail-columns mail-columns-personal");
    expect(html).toMatch(/mail-columns-head-cells"><span>To<\/span><span>Subject<\/span><span[^>]*>Started by<\/span>/);
    expect(html).toMatch(/class="mail-row-cell mail-row-subject-cell"[^>]*><span class="mail-row-tag mail-row-draft-tag"/);
    expect(html).toContain('aria-label="Started by Mail provider"');
    expect(html).toContain("--mail-time-samples");
  });

  test("names a draft without recipients or subject", () => {
    const html = render({ items: [draft({ to: [], cc: [], subject: "", attachmentCount: 0 })], nextCursor: null, total: 1 });
    expect(html).toMatch(/class="mail-row-sender"[^>]*>No recipients</);
    expect(html).toContain("(No subject)");
    expect(html).not.toContain("mail-row-marks");
  });

  test("shows readers the drafts without links, menus or delete", () => {
    const html = render({ items: [draft({ to: [], cc: [] })], nextCursor: null, total: 1 }, { canWrite: false });
    expect(html).toContain("Quarterly figures");
    expect(html).toContain("Draft");
    expect(html).not.toContain("/compose/");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("Actions for");
    expect(html).not.toContain("aria-keyshortcuts");
  });

  test("explains an empty Drafts folder", () => {
    const html = render({ items: [], nextCursor: null, total: 0 });
    expect(html).toContain("No drafts");
    expect(html).toMatch(/<h1[^>]*class="sr-only"[^>]*>Drafts<\/h1>/);
  });
});
