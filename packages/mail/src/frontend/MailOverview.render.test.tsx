import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";

const root = mkdtempSync(join(tmpdir(), "mail-overview-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ default: MailOverview }, { LocaleProvider }] = await Promise.all([import("./MailOverview.island.tsx"), import("@k2b/ui")]);

const renderOverview = (
  initialFocusError: string | null = null,
  initialPinnedMailboxIds: string[] = [],
  mailboxCount = { unread: 1, needsAction: 1 },
  locale = "en",
) =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MailOverview, {
          mailboxes: [
            {
              id: "Mail01",
              name: "Support",
              description: "Customer conversations",
              health: "active",
              healthReason: null,
              syncEnabled: true,
              searchBackend: "auto",
              automaticReplyManagementPermission: "admin",
              composeSafety: { internalDomains: ["example.test"], largeRecipientThreshold: 20 },
              createdAt: "2026-08-19T10:00:00.000Z",
              updatedAt: "2026-08-19T10:00:00.000Z",
              permission: "admin",
              receivingAddress: "support@example.test",
            },
          ],
          initialView: "mine",
          initialSelection: null,
          initialDetail: null,
          initialPinnedMailboxIds,
          initialFocusError,
          currentUserEmail: "user@example.com",
          contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
          dateConfig: { locale: "en", timeZone: "Europe/Berlin" },
          initialFocus: {
            items: [
              {
                id: "Convo1",
                mailboxId: "Mail01",
                mailboxName: "Support",
                subject: "Release update",
                participantSummary: "Ada",
                latestMessageAt: "2026-08-19T10:00:00.000Z",
                workStatus: "needs_action",
                assigneeUserId: "00000000-0000-4000-8000-000000000001",
                unread: true,
                flagged: true,
                hasAttachments: true,
                preview: "Ready to ship",
              },
            ],
            counts: { mine: 1, unassigned: 2, waiting: 3, all: 6 },
            mailboxCounts: [{ mailboxId: "Mail01", ...mailboxCount }],
            nextCursor: null,
          },
        });
      },
    }),
  );

const mailboxRow = (html: string) => html.match(/<div[^>]*mail-overview-mailbox[\s\S]*?<\/a>/)?.[0] ?? "";

describe("Mail overview", () => {
  test("renders the server-provided cross-mailbox focus queue and accessible view controls", () => {
    const html = renderOverview();
    expect(html).toContain('class="k2b-app-workspace mail-focus-workspace"');
    // Objects live in a stacked-on-mobile sidebar, not in a mailbox-style tree.
    expect(html).toMatch(/<aside[^>]*aria-label="Mailboxes"[^>]*data-mobile="stacked"/);
    expect(html).not.toContain("k2b-app-workspace__nav-tree");
    expect(html).toContain("--k2b-workspace-sidebar-width:304px");
    expect(html.match(/data-variant="object"/g)).toHaveLength(1);
    expect(html).toMatch(/class="k2b-app-workspace__main[^"]*mail-focus-main ?"[^>]*data-width="content"/);
    expect(html).toContain('href="/app/mail/Mail01?view=needs_action"');
    expect(html).toContain("support@example.test");
    expect(html).toContain("1 unread");
    expect(html).toContain("1 need action");
    expect(html).toContain('aria-label="Pin Support"');
    expect(html.indexOf("New mailbox")).toBeGreaterThan(html.indexOf("Support"));
    expect(html).toContain("Recently deleted mailboxes");
    // The main area is a page: title, scope, primary action, one segmented view control.
    expect(html).toMatch(/<h2 class="k2b-panel-header__title is-large">Focus<\/h2>/);
    expect(html).toContain("1 conversation assigned to you · All mailboxes");
    expect(html).toContain('href="/app/mail/compose"');
    expect(html).toContain("Compose");
    expect(html).toMatch(/class="k2b-tag mail-overview-scope"[^>]*>.*All mailboxes/);
    expect(html).toContain('role="radiogroup" aria-label="Mail focus view"');
    expect(html).toContain('role="radio" class="k2b-segmented-control__option" aria-checked="true"');
    expect(html).not.toContain('role="tablist"');
    expect(html).toContain("For me");
    expect(html).toContain('<span class="mail-focus-tab-count">1</span>');
    expect(html).toContain("Unassigned");
    expect(html).toContain('<span class="mail-focus-tab-count">2</span>');
    expect(html).toContain("Release update");
    expect(html).toContain('class="mail-focus-avatar"');
    expect(html).toContain("Ada");
    expect(html).toContain('href="/app/mail/Mail01?conversation=Convo1"');
    expect(html).toContain("Flagged");
    expect(html).toContain("Attachment");
    expect(html).toMatch(/<aside[^>]*id="k2b-workspace-detail-mail-focus-detail"[^>]*hidden/);
  });

  test("distinguishes an initial focus failure from an empty queue", () => {
    const html = renderOverview("Focus service unavailable");
    expect(html).toContain("Could not load focused mail");
    expect(html).toContain("Focus service unavailable");
    expect(html).toContain("Retry");
    expect(html).not.toContain("Nothing for me");
  });

  test("renders a persisted mailbox pin with an accessible unpin action", () => {
    const html = renderOverview(null, ["Mail01"]);
    expect(html).toContain('aria-label="Unpin Support"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("ti-flag");
    expect(html).toContain("ti-flag-off");
    expect(html).toContain('data-variant="text"');
  });

  test("shows needs action as the only number and unread as a dot", () => {
    const row = mailboxRow(renderOverview(null, [], { unread: 1234, needsAction: 5 }));
    expect(row).toContain('<span class="mail-overview-unread-dot"');
    expect(row).toMatch(/<span class="mail-overview-needs-action" aria-hidden="true">5<\/span>/);
    expect(row).not.toContain("1,234</span>");
    expect(row).toContain('title="Support · support@example.test · 5 need action · 1234 unread"');
    expect(row).toContain('<span class="sr-only">5 need action, 1234 unread</span>');
  });

  test("shows only the unread dot without a number when nothing needs action", () => {
    const row = mailboxRow(renderOverview(null, [], { unread: 3, needsAction: 0 }));
    expect(row).toContain('<span class="mail-overview-unread-dot"');
    expect(row).toMatch(/<span class="mail-overview-needs-action" aria-hidden="true"><\/span>/);
    expect(row).toContain('title="Support · support@example.test · 3 unread"');
    expect(row).toContain('<span class="sr-only">3 unread</span>');
  });

  test("leaves the count column empty without a dot or a zero", () => {
    const row = mailboxRow(renderOverview(null, [], { unread: 0, needsAction: 0 }));
    expect(row).not.toContain("mail-overview-unread-dot");
    expect(row).toMatch(/<span class="mail-overview-needs-action" aria-hidden="true"><\/span>/);
    expect(row).not.toMatch(/>0</);
    expect(row).toContain('title="Support · support@example.test"');
    expect(row).not.toContain("sr-only");
  });

  test("localizes the count tooltip and screen-reader text", () => {
    const row = mailboxRow(renderOverview(null, [], { unread: 2, needsAction: 7 }, "de"));
    expect(row).toContain("7 mit Handlungsbedarf · 2 ungelesen");
    expect(row).toContain('<span class="sr-only">7 mit Handlungsbedarf, 2 ungelesen</span>');
  });
});
