import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(join(tmpdir(), "mail-overview-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailOverview } = await import("./MailOverview.island.tsx");

const renderOverview = (initialFocusError: string | null = null, initialPinnedMailboxIds: string[] = []) =>
  renderToString(() =>
    createComponent(MailOverview, {
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
      deletedMailboxes: [],
      initialDeletedCursor: null,
      initialView: "mine",
      initialSelection: null,
      initialDetail: null,
      initialPinnedMailboxIds,
      initialFocusError,
      currentUserEmail: "user@example.com",
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
        mailboxCounts: [{ mailboxId: "Mail01", unread: 1, needsAction: 1 }],
        nextCursor: null,
      },
    }),
  );

describe("Mail overview", () => {
  test("renders the server-provided cross-mailbox focus queue and accessible view controls", () => {
    const html = renderOverview();
    expect(html).toContain('class="k2b-app-workspace mail-focus-workspace"');
    expect(html).not.toContain("What needs attention across your mailboxes.");
    expect(html).toContain('href="/app/mail/compose"');
    expect(html).toContain("Compose");
    expect(html).toContain('href="/app/mail/Mail01"');
    expect(html).toContain("1 unread");
    expect(html).toContain("1 need action");
    expect(html.match(/mail-focus-mailbox-button/g)).toHaveLength(12);
    expect(html.match(/data-layout-smoke="true"/g)).toHaveLength(11);
    expect(html).toContain('aria-label="Pin Support"');
    expect(html.indexOf("New mailbox")).toBeGreaterThan(html.indexOf("Product feedback"));
    expect(html).toContain('role="tablist" aria-label="Mail focus view"');
    expect(html).toContain('role="tab" aria-selected="true"');
    expect(html).toContain('For me <span class="mail-focus-tab-count">1</span>');
    expect(html).toContain('Unassigned <span class="mail-focus-tab-count">2</span>');
    expect(html).toContain("1 conversation assigned to you");
    expect(html).toContain("Assigned to you");
    expect(html).toContain("Release update");
    expect(html).toContain('class="mail-focus-avatar"');
    expect(html).toContain("Ada");
    expect(html).toContain("Support");
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

  test("renders pinned mailboxes first with an accessible unpin action", () => {
    const html = renderOverview(null, ["Smk009"]);
    expect(html.indexOf("Product feedback")).toBeLessThan(html.indexOf("Support"));
    expect(html).toContain('aria-label="Unpin Product feedback"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("ti-flag");
    expect(html).toContain("ti-flag-off");
    expect(html).toContain('data-variant="text"');
  });
});
