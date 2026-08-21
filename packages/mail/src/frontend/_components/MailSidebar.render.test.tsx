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
      showInSidebar: true,
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
});
