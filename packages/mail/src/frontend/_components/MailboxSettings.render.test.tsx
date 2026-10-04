import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { MailboxSettingsContext } from "../../settings-context";

const root = mkdtempSync(join(tmpdir(), "mailbox-settings-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { default: MailboxSettings } = await import("./MailboxSettings.tsx");

const now = "2026-08-11T10:00:00.000Z";
const mailboxId = "00000000-0000-4000-8000-000000000001";
const context = (permission: MailboxSettingsContext["permission"], options: { spacesCalendar?: boolean } = {}): MailboxSettingsContext => ({
  mailbox: {
    id: mailboxId,
    name: "Support",
    description: "Customer conversations",
    health: "active",
    healthReason: null,
    syncEnabled: true,
    searchBackend: "auto",
    automaticReplyManagementPermission: "admin",
    composeSafety: { internalDomains: ["example.test"], largeRecipientThreshold: 20 },
    createdAt: now,
    updatedAt: now,
  },
  permission,
  integrations: { spacesCalendar: options.spacesCalendar ?? false },
  organization: { savedViews: [], localTags: [] },
  compose:
    permission === "read"
      ? null
      : {
          templates: [],
          defaults: [],
          style: { mailboxId, customCss: "", revision: 1, updatedAt: now },
          identities: [],
        },
  admin: permission === "admin" ? { accessEntries: [], bindings: [], connections: [], folders: [], identities: [] } : null,
});

const renderSettings = (
  permission: MailboxSettingsContext["permission"],
  initialTab?: string,
  options?: { spacesCalendar?: boolean },
  admin?: Partial<NonNullable<MailboxSettingsContext["admin"]>>,
) =>
  renderToString(() =>
    createComponent(MailboxSettings, {
      context: (() => {
        const value = context(permission, options);
        return value.admin && admin ? { ...value, admin: { ...value.admin, ...admin } } : value;
      })(),
      initialTab,
      currentUserEmail: "user@example.test",
      reloading: false,
      onReload: async () => undefined,
      onContextChange: () => undefined,
      onWorkspaceChange: () => undefined,
      onClose: () => undefined,
      onDeleted: () => undefined,
    }),
  );

describe("Mailbox settings composition", () => {
  test("groups administrator categories and renders one panel footer", () => {
    const html = renderSettings("admin");

    for (const group of ["Personal", "Mailbox", "Delivery", "Sharing", "Lifecycle"]) expect(html).toContain(group);
    expect(html).toContain("Shared identity and sending safeguards.");
    expect(html).toContain('class="k2b-settings-group"');
    expect(html).toContain('<footer class="k2b-settings__footer">');
    expect(html.match(/<footer class="k2b-settings__footer">/g)).toHaveLength(1);
    expect(html).not.toContain("Mailbox admins");
  });

  test("keeps writer controls separate from administrator settings", () => {
    const html = renderSettings("write", "writing");

    expect(html).toContain("Compose");
    expect(html).toContain("My writing defaults");
    expect(html).toContain("Signatures and snippets");
    expect(html).toContain('class="flex flex-col gap-8"');
    expect(html).toContain("Organization");
    expect(html).not.toContain("Shared identity and sending safeguards.");
    expect(html).not.toContain("Accounts &amp; identities");
    expect(html).not.toContain("Danger zone");
  });

  test("keeps stable deep links and separates Calendar from the General footer", () => {
    expect(renderSettings("admin", "general")).toContain("Set the name and context collaborators see.");
    expect(renderSettings("admin", "connections")).toContain("Connected account");

    const calendar = renderSettings("admin", "calendar", { spacesCalendar: true });
    expect(calendar).toContain("Default destination for imported invitations.");
    expect(calendar).toContain("Default destination");
    expect(calendar).not.toContain("No unsaved changes");
  });

  test("keeps connected accounts and sending identities in one spaced stack", () => {
    const html = renderSettings("admin", "delivery");

    expect(html).toContain("Connected account");
    expect(html).toContain("Sending identities");
    expect(html).toContain('class="flex flex-col gap-8"');
  });

  test("keeps reader settings personal and hides administrator categories", () => {
    const html = renderSettings("read", "reading");

    expect(html).toContain("Message display");
    expect(html).toContain("This preference applies only to this browser.");
    expect(html).not.toContain("Compose");
    expect(html).not.toContain("Accounts &amp; identities");
    expect(html).not.toContain("Danger zone");
  });

  test("shows the folders as one tree with each folder's display, inherited displays, and provider groups", () => {
    type AdminFolder = NonNullable<MailboxSettingsContext["admin"]>["folders"][number];
    const folder = (id: string, name: string, overrides: Partial<AdminFolder> = {}): AdminFolder => ({
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
      subscribed: true,
      rightsSource: "acl",
      effectiveRights: [],
      canCreateChildren: false,
      canRename: false,
      canDelete: false,
      canManageSubscription: false,
      ...overrides,
    });
    const html = renderSettings("admin", "folders", undefined, {
      folders: [
        folder("Fold01", "Inbox", { role: "inbox", providerRole: "inbox" }),
        folder("Fold02", "Shared", { display: "folder_only", namespaceKinds: ["shared"] }),
        folder("Fold03", "Team", { parentId: "Fold02", namespaceKinds: ["shared"] }),
        folder("Fold04", "Important", { parentId: "Fold03", display: "hidden", namespaceKinds: ["shared"] }),
        folder("Fold05", "Old project", { discoveryState: "missing" }),
        folder("Fold06", "[Gmail]", { selectable: false }),
        folder("Fold07", "Important", { parentId: "Fold06", displayNeutral: true }),
        folder("Fold08", "Sent Mail", { parentId: "Fold06", role: "sent", providerRole: "sent", displayNeutral: true }),
      ],
    });
    const rows = [...html.matchAll(/aria-label="([^"]*)" type="button" class="k2b-dropdown__trigger mail-folder-tree__main/g)].map(
      (match) => match[1],
    );

    expect(rows).toEqual([
      "Inbox, Everywhere",
      "Shared, Shared by provider, Only in the folder",
      "Team, Shared by provider, Only in the folder, inherited from Shared",
      "Important, in Shared / Team, Shared by provider, Hidden",
      "Old project, Unavailable",
      "[Gmail], Everywhere",
      "Important, in [Gmail], Everywhere",
      "Sent Mail, Everywhere",
    ]);
    // Groups read as headers: their folders start unindented, and the header counts them.
    expect(html).toContain('data-group="" data-effective="everywhere"');
    expect(html).toContain("Folder group · 2 folders");
    expect(html.match(/style="--mail-folder-depth:0"/g)).toHaveLength(6);
    // The default needs no words in the row; deviations and the inherited source do.
    expect(html).toContain('data-kind="default"');
    expect(html).toContain('<span class="mail-folder-tree__state-long">inherited from Shared</span>');
    // The menu explains the three displays, how far a change reaches, and what a parent already decides.
    expect(html).toContain("Also applies to 2 subfolders.");
    expect(html).toContain("Set by “Shared”. Change it there.");
    expect(html).toContain("Not needed: this folder never decides what combined views show.");
  });
});
