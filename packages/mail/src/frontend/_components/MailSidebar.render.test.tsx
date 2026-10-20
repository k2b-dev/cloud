import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { selectHtml } from "../../../../../tests/fixtures/select-html";
import type { MailFolderView } from "../../service/messages";

const root = mkdtempSync(join(tmpdir(), "mail-sidebar-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailSidebar } = await import("./MailSidebar.tsx");

const { mailSidebarFixture, openMailboxFixture } = await import("./mail-sidebar.fixture");
const sidebar = (overrides: Partial<Parameters<typeof MailSidebar>[0]> = {}) => createComponent(MailSidebar, mailSidebarFixture(overrides));
const renderSidebar = (overrides: Partial<Parameters<typeof MailSidebar>[0]> = {}) => renderToString(() => sidebar(overrides));

const { createMailboxPreferences } = await import("./mail-mailbox-preferences");
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

describe("Mail sidebar", () => {
  test("Focus and a mailbox list the same mailboxes in pin order, with only the open folder group", async () => {
    const render = (open: boolean) =>
      renderSidebar({
        mailboxes: [
          { id: "Box002", name: "Sales", health: "active", healthReason: null, receivingAddress: null },
          { id: "Box001", name: "Support", health: "active", healthReason: null, receivingAddress: null },
        ],
        open: open ? openMailboxFixture() : null,
        preferences: createMailboxPreferences({ pinnedMailboxIds: ["Box001"], hiddenMailboxIds: [] }),
      });
    const focus = render(false);
    const mailbox = render(true);
    const rows = async (html: string) => (await selectHtml(html, "[data-mailbox]")).map((row) => row.attributes["data-mailbox"]);
    expect(await rows(focus)).toEqual(["Box001", "Box002"]);
    expect(await rows(mailbox)).toEqual(await rows(focus));
    expect(await selectHtml(focus, '[role="group"][aria-label="Folders of Support"]')).toHaveLength(0);
    expect(await selectHtml(mailbox, ".mail-sidebar-folders")).toHaveLength(1);
    expect((await selectHtml(focus, 'a[href="/app/mail"]'))[0]?.attributes["aria-current"]).toBe("page");
    expect((await selectHtml(mailbox, '[data-mailbox="Box001"] a'))[0]?.attributes["aria-current"]).toBe("page");
    expect((await selectHtml(mailbox, 'a[href="/app/mail"]'))[0]?.attributes["aria-current"]).toBeUndefined();
  });

  test("phone title navigation lists places, hidden mailboxes and New mailbox without views or tools", () => {
    const html = renderSidebar({
      open: openMailboxFixture({
        folders: [
          folder("Inbox1", "Inbox", "inbox", 20, 5),
          folder("Draft1", "Drafts", "drafts", 3, 0),
          folder("Sent01", "Sent", "sent", 20, 2),
          folder("Arch01", "Archive", "archive", 9, 4),
          folder("Cust01", "Customers", "other", 9, 4),
        ],
      }),
      mailboxes: [
        { id: "Box001", name: "Support", health: "active", healthReason: null, receivingAddress: null },
        { id: "Box002", name: "Sales", health: "active", healthReason: null, receivingAddress: null },
        { id: "Box003", name: "Hidden box", health: "active", healthReason: null, receivingAddress: null },
      ],
      preferences: createMailboxPreferences({ pinnedMailboxIds: ["Box002"], hiddenMailboxIds: ["Box003"] }),
    });
    type Entry = { id: string; label: string; children?: Entry[] };
    const snapshot = JSON.parse(/<script[^>]*data-cloud-workspace-navigation[^>]*>(.*?)<\/script>/s.exec(html)![1]!) as { items: Entry[] };
    const flatten = (items: Entry[]): Entry[] => items.flatMap((item) => [item, ...flatten(item.children ?? [])]);
    expect(flatten(snapshot.items).map((item) => item.label)).toEqual([
      "Focus",
      "Mailboxes",
      "Sales",
      "Support",
      "Inbox",
      "Drafts",
      "Scheduled",
      "Send problems",
      "Sent",
      "More",
      "Archive",
      "Customers",
      "Hidden mailboxes",
      "Hidden box",
      "New mailbox",
    ]);
  });

  test("mailbox navigation is enhanced only when its island owns mailbox switches", () => {
    for (const enhanced of [false, true]) {
      const html = renderSidebar({ open: openMailboxFixture(), onOpenMailbox: enhanced ? () => {} : undefined });
      const snapshot = JSON.parse(/<script[^>]*data-cloud-workspace-navigation[^>]*>(.*?)<\/script>/s.exec(html)![1]!);
      const entry = snapshot.items.find((item: { id: string }) => item.id === "mailboxes").children[0];
      expect(entry.navigation).toBe(enhanced ? "enhanced" : undefined);
      expect(entry.scroll).toBe(enhanced ? "preserve" : undefined);
    }
  });

  test("phone navigation distinguishes the mailbox context from its active folder", () => {
    const html = renderSidebar({
      mailboxes: [
        { id: "Box001", name: "Support", health: "active", healthReason: null, receivingAddress: null },
        { id: "Box002", name: "Sales", health: "active", healthReason: null, receivingAddress: null },
      ],
      open: openMailboxFixture({ activeFolderId: "Inbox1", folders: [folder("Inbox1", "Inbox", "inbox", 20, 5)] }),
    });
    type Entry = { id: string; context?: boolean; active?: boolean; children?: Entry[] };
    const snapshot: { items: Entry[] } = JSON.parse(/<script[^>]*data-cloud-workspace-navigation[^>]*>(.*?)<\/script>/s.exec(html)![1]!);
    const boxes = snapshot.items.find((item) => item.id === "mailboxes")!.children!;
    const current = boxes.find((item) => item.id === "mailbox:Box001")!;
    expect(current.context).toBe(true);
    expect(current.active).toBe(false);
    expect(current.children!.find((item) => item.id === "folder:Inbox1")!.active).toBe(true);
    expect(boxes.find((item) => item.id === "mailbox:Box002")!.context).toBe(false);
    expect(snapshot.items.find((item) => item.id === "focus")!.context).toBeUndefined();
  });

  test("a hidden open mailbox stays expanded, and a folder marks its own row instead of the mailbox", async () => {
    const html = renderSidebar({
      preferences: createMailboxPreferences({ pinnedMailboxIds: [], hiddenMailboxIds: ["Box001"] }),
      open: openMailboxFixture({ activeFolderId: "Inbox1", folders: [folder("Inbox1", "Inbox", "inbox", 20, 5)] }),
    });
    expect((await selectHtml(html, ".mail-sidebar-hidden-mailboxes button[aria-expanded]"))[0]?.attributes["aria-expanded"]).toBe("true");
    expect((await selectHtml(html, '[data-mailbox="Box001"] a'))[0]?.attributes["aria-current"]).toBeUndefined();
    expect((await selectHtml(html, 'a[href="/app/mail/Box001?folder=Inbox1"]'))[0]?.attributes["aria-current"]).toBe("page");
    expect(html).toContain(", 5 unread");
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
      open: openMailboxFixture({
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
      }),
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
    // Unread counts use the shared status, present from the first paint also at zero,
    // so a long folder name keeps one line and the first new mail never moves the rows below.
    expect(newsletter).toContain('data-unread="count"');
    expect(newsletter).toContain(", 12 unread");
    const shared = desktop.slice(desktop.indexOf('title="Shared'), desktop.indexOf('title="Projects'));
    expect(shared).toContain('class="k2b-app-workspace__sidebar-status"');
    expect(shared).not.toContain("data-unread");

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
});
