import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { MailFolderView } from "../../service/messages";

const root = mkdtempSync(join(tmpdir(), "mail-sidebar-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailSidebar } = await import("./MailSidebar.tsx");

const renderSidebar = (overrides: Partial<Parameters<typeof MailSidebar>[0]> = {}) =>
  renderToString(() =>
    createComponent(MailSidebar, {
      mailboxId: "Box001",
      mailboxName: "Support",
      syncEnabled: true,
      needsConnection: false,
      folders: [],
      localTags: [],
      savedViews: [],
      scheduledMode: false,
      scheduledCount: 0,
      activeFolderId: null,
      activeView: null,
      activeSavedViewId: null,
      activeTagId: null,
      searchActive: false,
      viewCounts: {
        needs_action: 2,
        mine: 1,
        unassigned: 1,
        waiting: 3,
        done: 4,
        snoozed: 0,
        send_problems: 0,
        recently_active: 5,
      },
      canWrite: true,
      canAdmin: true,
      managementOpening: null,
      settingsOpening: false,
      detailsOpening: false,
      onOpenDetails: () => {},
      onOpenHealth: () => {},
      onOpenSharedLinks: () => {},
      onOpenRemoteContent: () => {},
      onOpenSubscriptions: () => {},
      onOpenSettings: () => {},
      onMoveConversation: () => {},
      onNavigate: () => {},
      ...overrides,
    }),
  );

describe("Mail sidebar", () => {
  test("separates follow-up and assignment and links stable tag IDs", () => {
    const html = renderSidebar({
      localTags: [
        {
          id: "Tag001",
          mailboxId: "Box001",
          name: "Important",
          color: "#2563eb",
          revision: 1,
          createdAt: "2026-08-15T00:00:00.000Z",
          updatedAt: "2026-08-15T00:00:00.000Z",
        },
      ],
      activeTagId: "Tag001",
      searchActive: true,
    });

    expect(html).toContain("Follow-up");
    expect(html).toContain("Assignment");
    expect(html).toContain("Tags");
    expect(html).toContain("Important");
    expect(html).toContain("local_tag_id");
    expect(html).toContain("Tag001");
    expect(html).not.toContain('title="Work"');
  });

  test("keeps secondary destinations with Mail and gives primary counts useful semantics", () => {
    const folder = (id: string, name: string, role: string, total: number, unread: number): MailFolderView => ({
      id,
      parentId: null,
      name,
      role,
      providerRole: role,
      configuredRole: null,
      selectable: true,
      display: "everywhere",
      effectiveDisplay: "everywhere",
      displayInheritedFromFolderId: null,
      displayNeutral: false,
      namespaceKinds: ["personal"],
      discoveryState: "active",
      missingSince: null,
      syncStatus: "current",
      total,
      unread,
    });
    const html = renderSidebar({
      scheduledCount: 7,
      viewCounts: {
        needs_action: 2,
        mine: 1,
        unassigned: 1,
        waiting: 3,
        done: 4,
        snoozed: 0,
        send_problems: 2,
        recently_active: 5,
      },
      folders: [
        folder("00000000-0000-4000-8000-000000000001", "Inbox", "inbox", 20, 5),
        folder("00000000-0000-4000-8000-000000000002", "Drafts", "drafts", 3, 0),
        folder("00000000-0000-4000-8000-000000000003", "Sent", "sent", 20, 2),
        folder("00000000-0000-4000-8000-000000000004", "Trash", "trash", 9, 4),
      ],
    });

    const desktop = html.slice(html.indexOf('class="k2b-app-workspace__sidebar-desktop'));
    const mailSection = desktop.slice(desktop.indexOf(">Mail<"), desktop.indexOf(">Folders<"));
    expect(mailSection.indexOf("Sent")).toBeLessThan(mailSection.indexOf("More"));
    expect(mailSection.indexOf("More")).toBeLessThan(mailSection.indexOf("All mail"));
    expect(mailSection).toContain("Inbox");
    expect(mailSection).toContain(">5<");
    expect(mailSection).toContain("Drafts");
    expect(mailSection).toContain(">3<");
    expect(mailSection).toContain("Scheduled");
    expect(mailSection).toContain(">7<");
    expect(mailSection).toContain("Send problems");
    expect(mailSection).toContain(">2<");
    expect(mailSection.slice(mailSection.indexOf("Sent"), mailSection.indexOf("More"))).not.toContain(">2<");
    expect(mailSection).toContain("Trash");
    expect(desktop).toContain("mail-compose-action");
  });

  test("marks where Only in the folder is set and keeps the unread count beside it", () => {
    const folder = (id: string, name: string, overrides: Partial<MailFolderView> = {}): MailFolderView => ({
      id,
      parentId: null,
      name,
      role: "other",
      providerRole: "other",
      configuredRole: null,
      selectable: true,
      display: "everywhere",
      effectiveDisplay: "everywhere",
      displayInheritedFromFolderId: null,
      displayNeutral: false,
      namespaceKinds: ["personal"],
      discoveryState: "active",
      missingSince: null,
      syncStatus: "current",
      total: 0,
      unread: 0,
      ...overrides,
    });
    const html = renderSidebar({
      folders: [
        folder("Fold01", "Newsletter", { display: "folder_only", effectiveDisplay: "folder_only", unread: 12 }),
        folder("Fold02", "Shared", { display: "folder_only", effectiveDisplay: "folder_only" }),
        folder("Fold03", "Projects", {
          parentId: "Fold02",
          effectiveDisplay: "folder_only",
          displayInheritedFromFolderId: "Fold02",
          unread: 2,
        }),
        folder("Fold04", "Customers", { unread: 3 }),
      ],
    });
    const desktop = html.slice(html.indexOf('class="k2b-app-workspace__sidebar-desktop'));

    expect(desktop.match(/data-mail-folder-only/g)).toHaveLength(2);
    expect(desktop).toContain('title="Newsletter: only in the folder, not in combined views such as Needs action"');
    expect(desktop).toContain('title="Shared: only in the folder, not in combined views such as Needs action"');
    expect(desktop).toContain('title="Projects"');
    expect(desktop).toContain('title="Customers"');
    const newsletter = desktop.slice(desktop.indexOf('title="Newsletter'), desktop.indexOf('title="Shared'));
    expect(newsletter).toContain('<span class="sr-only">Only in the folder</span>');
    expect(newsletter).toContain("12");

    // The phone navigation names it too, below the folder's name.
    type Entry = { id: string; description?: string; children?: Entry[] };
    const json = /<script[^>]*data-cloud-workspace-navigation[^>]*>(.*?)<\/script>/s.exec(html)?.[1];
    const flatten = (entries: Entry[]): Entry[] => entries.flatMap((entry) => [entry, ...flatten(entry.children ?? [])]);
    const phone = flatten((JSON.parse(json ?? "{}") as { items: Entry[] }).items).filter((entry) => entry.id.startsWith("folder:"));
    expect(Object.fromEntries(phone.map((entry) => [entry.id, entry.description ?? null]))).toEqual({
      "folder:Fold01": "Only in the folder",
      "folder:Fold02": "Only in the folder",
      "folder:Fold03": null,
      "folder:Fold04": null,
    });
  });

  test("puts the mailbox details beside Compose, and gives readers them too", () => {
    type Entry = { id: string; label: string; action?: string; inlineActions?: Entry[] };
    const phoneItems = (html: string) =>
      (JSON.parse(/<script[^>]*data-cloud-workspace-navigation[^>]*>(.*?)<\/script>/s.exec(html)?.[1] ?? "{}") as { items: Entry[] }).items;
    const actionsRow = (html: string) => {
      const desktop = html.slice(html.indexOf('class="k2b-app-workspace__sidebar-desktop'));
      return desktop.slice(desktop.indexOf("mail-sidebar-actions"), desktop.indexOf("k2b-app-workspace__sidebar-body"));
    };

    const writer = renderSidebar();
    const writerRow = actionsRow(writer);
    expect(writerRow.indexOf("mail-compose-action")).toBeLessThan(writerRow.indexOf("mail-details-action"));
    expect(writerRow).toContain('aria-label="Mailbox details"');
    expect(writerRow).toContain("ti ti-info-circle");
    // On phones the details share Compose's row in the app menu.
    const [compose] = phoneItems(writer);
    expect(compose?.id).toBe("compose");
    expect(compose?.inlineActions?.map((action) => [action.id, action.label, action.action])).toEqual([
      ["details", "Mailbox details", "details"],
    ]);

    const reader = renderSidebar({ canWrite: false, canAdmin: false });
    const readerRow = actionsRow(reader);
    expect(readerRow).not.toContain("mail-compose-action");
    expect(readerRow).toContain('aria-label="Mailbox details"');
    const [details] = phoneItems(reader);
    expect([details?.id, details?.action]).toEqual(["details", "details"]);
  });
});
