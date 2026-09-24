import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { MailFolderView } from "../../service/messages";
import type { MailboxPageData } from "../../service/workspace";

type Fixture = { folders: MailFolderView[]; internal: Map<string, string>; publicIds: Map<string, string> };

// A realistic IMAP hierarchy: system folders, non-selectable containers, the same leaf name under different
// parents, and more than 300 folders so a truncating bound or a dropped parent would show up.
const folderFixture = (): Fixture => {
  const folders: MailFolderView[] = [];
  const internal = new Map<string, string>();
  const publicIds = new Map<string, string>();
  const add = (key: string, name: string, parent: string | null, options: Partial<MailFolderView> = {}) => {
    const index = folders.length + 1;
    const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    internal.set(key, id);
    publicIds.set(id, `F${index.toString().padStart(5, "0")}`);
    folders.push({
      id,
      parentId: parent ? internal.get(parent)! : null,
      name,
      role: "other",
      providerRole: "other",
      configuredRole: null,
      selectable: true,
      showInSidebar: true,
      namespaceKinds: ["personal"],
      discoveryState: "active",
      missingSince: null,
      syncStatus: "current",
      total: 0,
      unread: 0,
      ...options,
    });
  };
  add("inbox", "Inbox", null, { role: "inbox", providerRole: "inbox", unread: 4 });
  add("sent", "Sent", null, { role: "sent", providerRole: "sent" });
  add("projects", "Projekte", null, { selectable: false });
  add("2025", "2025", "projects");
  add("2025/archive", "Archiv", "2025", { unread: 7 });
  add("2024", "2024", "projects");
  add("2024/archive", "Archiv", "2024", { unread: 3 });
  for (let group = 0; group < 20; group += 1) {
    add(`bulk-${group}`, `Kunde ${group}`, null, { selectable: false });
    for (let child = 0; child < 16; child += 1) add(`bulk-${group}-${child}`, `Archiv ${child}`, `bulk-${group}`);
  }
  // Children listed before their parents: nesting must not depend on input order.
  add("late-child", "Archiv", null);
  add("late-parent", "Vereine", null);
  folders.at(-2)!.parentId = internal.get("late-parent")!;
  return { folders, internal, publicIds };
};

const pageData = (folders: MailFolderView[]) =>
  ({
    mailbox: { id: "00000000-0000-4000-8000-00000000ffff" },
    folders,
    identities: [],
    savedViewId: null,
    savedViews: [],
    folderId: null,
    selectedConversationId: null,
    selectedMessageId: null,
    listItems: [],
    detailMessages: [],
    conversationDrafts: [],
    localTags: [],
    conversationLocalTags: null,
    comments: [],
    reminder: null,
    collaborationState: null,
    scheduledPage: null,
    activity: [],
  }) as unknown as MailboxPageData;

afterEach(() => mock.restore());

if (!isServer) {
  const projections: Array<[string, (fixture: Fixture) => Promise<MailFolderView[]>]> = [
    [
      "SSR page payload",
      async ({ folders, publicIds }) => {
        const { projectMailboxPageData } = await import("../ssr-public-boundary");
        const mailboxId = "00000000-0000-4000-8000-00000000ffff";
        const load = async (_table: string, values: Array<string | null | undefined>) =>
          new Map(values.flatMap((id) => (id ? [[id, id === mailboxId ? "Box001" : publicIds.get(id)!] as const] : [])));
        return (await projectMailboxPageData(pageData(folders), load)).folders;
      },
    ],
    [
      "client refresh payload",
      async ({ folders, publicIds }) => {
        const { publicResources } = await import("../../service");
        const { aggregateResourcePaths } = await import("../../api/index");
        const { projectResourcePaths } = await import("../../api/public-resource-boundary");
        spyOn(publicResources, "publicIds").mockImplementation(
          async (_table, values) =>
            new Map(values.flatMap((id) => (id ? [[id, publicIds.get(id) ?? "Box001"] as const] : []))) as Map<string, string>,
        );
        const data = pageData(folders);
        const projected = await projectResourcePaths(ok(data), aggregateResourcePaths(data));
        if (!projected.ok) throw new Error("projection failed");
        return projected.data.folders;
      },
    ],
  ];

  for (const [boundary, project] of projections) {
    test(`the sidebar nests IMAP folders from the ${boundary}`, async () => {
      const dom = createDomTestHarness();
      const fixture = folderFixture();
      const folders = await project(fixture);
      const id = (key: string) => fixture.publicIds.get(fixture.internal.get(key)!)!;
      expect(folders).toHaveLength(fixture.folders.length);
      expect(folders.every((folder) => folder.parentId === null || /^[0-9A-Za-z]{6}$/.test(folder.parentId))).toBe(true);

      const { default: MailSidebar } = await import("./MailSidebar");
      const dispose = render(
        () => (
          <MailSidebar
            mailboxId="Box001"
            mailboxName="Support"
            syncEnabled={true}
            folders={folders}
            localTags={[]}
            savedViews={[]}
            scheduledMode={false}
            scheduledCount={0}
            activeFolderId={id("2025/archive")}
            activeView={null}
            activeSavedViewId={null}
            activeTagId={null}
            searchActive={false}
            viewCounts={{ needs_action: 0, mine: 0, unassigned: 0, waiting: 0, done: 0, snoozed: 0, send_problems: 0, recently_active: 0 }}
            canWrite={true}
            canAdmin={false}
            managementOpening={null}
            settingsOpening={false}
            onOpenHealth={() => {}}
            onOpenSharedLinks={() => {}}
            onOpenRemoteContent={() => {}}
            onOpenSubscriptions={() => {}}
            onOpenSettings={() => {}}
            onMoveConversation={() => {}}
            onNavigate={() => {}}
          />
        ),
        dom.root,
      );
      try {
        const tree = dom.root.querySelector<HTMLElement>('[role="tree"][aria-label="Mailbox folders"]')!;
        const node = (key: string) => tree.querySelector<HTMLElement>(`[data-k2b-nav-tree-id="${id(key)}"]`)!;
        const row = (key: string) => node(key).querySelector<HTMLElement>(":scope > .k2b-app-workspace__nav-tree-row")!;

        // Same-named leaves sit under their own parents, indented one level deeper each.
        for (const [leaf, parent] of [
          ["2025/archive", "2025"],
          ["2024/archive", "2024"],
          ["late-child", "late-parent"],
        ] as const) {
          expect(node(leaf).dataset.k2bNavTreeParentId).toBe(id(parent));
          expect(node(parent).contains(node(leaf))).toBe(true);
        }
        expect(node("2025").dataset.k2bNavTreeParentId).toBe(id("projects"));
        expect(node("projects").getAttribute("aria-level")).toBe("1");
        expect(node("2025/archive").getAttribute("aria-level")).toBe("3");
        expect(row("2025/archive").style.getPropertyValue("--k2b-sidebar-item-depth")).toBe("2");
        expect(tree.querySelectorAll(':scope > [role="treeitem"]')).toHaveLength(22);

        // Unread counts stay on their own folder, and the non-selectable container is an expandable group without a link.
        expect(row("2025/archive").textContent).toContain("7");
        expect(row("2024/archive").textContent).toContain("3");
        expect(row("projects").getAttribute("href")).toBeNull();
        expect(node("projects").getAttribute("aria-expanded")).toBe("true");
        row("projects").querySelector<HTMLElement>("[data-k2b-nav-tree-toggle]")!.click();
        expect(node("projects").getAttribute("aria-expanded")).toBe("false");
        expect(node("projects").querySelector('[role="group"]')).toBeNull();
        row("projects").querySelector<HTMLElement>("[data-k2b-nav-tree-toggle]")!.click();
        expect(node("2025/archive").getAttribute("aria-selected")).toBe("true");
      } finally {
        dispose();
        dom.cleanup();
      }
    });
  }
}
