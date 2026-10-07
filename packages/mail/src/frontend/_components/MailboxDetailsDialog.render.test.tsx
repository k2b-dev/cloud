import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SenderIdentity } from "../../contracts";
import type { MailboxDetailsDialogProps } from "./MailboxDetailsDialog";

const root = mkdtempSync(join(tmpdir(), "mailbox-details-render-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const [{ MailboxDetailsDialog, mailboxAddresses }, { LocaleProvider }] = await Promise.all([
  import("./MailboxDetailsDialog.tsx"),
  import("@k2b/ui"),
]);

const identity = (fromAddress: string, displayName: string, isDefault = false): SenderIdentity =>
  ({ id: `Id${fromAddress.length}`, fromAddress, displayName, label: displayName, isDefault, status: "verified" }) as SenderIdentity;

const props = (permission: MailboxDetailsDialogProps["permission"]): MailboxDetailsDialogProps => ({
  mailbox: { name: "Support", description: "Customer conversations", health: "active", healthReason: null },
  permission,
  identities: [identity("Support@Example.test", "Support Team", true), identity("billing@example.test", "Billing")],
  folderCount: 12,
  details: {
    access: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        principal: { type: "user", userId: "00000000-0000-4000-8000-0000000000a1" },
        permission: "admin",
        createdAt: "2026-10-01T00:00:00.000Z",
        displayName: "Ada Admin",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        principal: { type: "group", groupId: "00000000-0000-4000-8000-0000000000b1" },
        permission: "write",
        createdAt: "2026-10-01T00:00:00.000Z",
        displayName: "Support team",
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        principal: { type: "service_account", serviceAccountId: "00000000-0000-4000-8000-0000000000c1" },
        permission: "read",
        createdAt: "2026-10-01T00:00:00.000Z",
        displayName: "Triage agent",
        serviceAccountKind: "agent",
      },
    ],
    account: { email: "support@example.test", server: "imap.example.test", status: "active", lastVerifiedAt: null },
    lastSyncAt: "2026-10-07T09:30:00.000Z",
  },
  dateConfig: { locale: "en", timeZone: "UTC" },
});

const render = (permission: MailboxDetailsDialogProps["permission"], locale = "en") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(MailboxDetailsDialog, { ...props(permission), close: () => {} });
      },
    }),
  );

describe("Mailbox details", () => {
  test("lists each address once, the receiving address first, with a copy button", () => {
    const { identities, details } = props("read");
    // An identity that is not verified yet cannot send, so its address is not one the mailbox sends from.
    const pending = { ...identity("new@example.test", "New"), status: "unverified" as const };
    expect(mailboxAddresses(details.account, [...identities, pending])).toEqual([
      { address: "support@example.test", names: ["Support Team"], receiving: true, defaultSender: true },
      { address: "billing@example.test", names: ["Billing"], receiving: false, defaultSender: false },
    ]);
    const html = render("read");
    expect(html).toContain("Support Team · Receiving address · Default sender");
    expect(html).toContain('aria-label="Copy support@example.test"');
    expect(html).toContain('aria-label="Copy billing@example.test"');
  });

  test("shows a reader who has which access without letting them change it", () => {
    const html = render("read");
    for (const name of ["Ada Admin", "Support team", "Triage agent", "(Agent)"]) expect(html).toContain(name);
    // Read-only: no level pickers, remove buttons, picker, or way into the access settings.
    expect(html).not.toContain("Remove Ada Admin");
    expect(html).not.toContain("Permission for");
    expect(html).not.toContain("Manage access");
    // The group's coverage from the shared access display.
    expect(html).toContain('aria-label="Members of Support team"');
    expect(html).toContain("Your access");
    expect(html).toContain(">View<");
    expect(html).toContain("imap.example.test");
    expect(html).toContain('datetime="2026-10-07T09:30:00.000Z"');
    expect(html).toContain(">12<");
  });

  test("names the connection state instead of asking readers to act", () => {
    const html = renderToString(() =>
      createComponent(MailboxDetailsDialog, {
        ...props("read"),
        mailbox: { ...props("read").mailbox, health: "auth_required" },
        close: () => {},
      }),
    );
    expect(html).toContain("Sign-in required");
    expect(html).toContain('data-tone="warning"');
    expect(html).not.toContain("sign in again");
  });

  test("gives managers the way into the access settings", () => {
    const html = render("admin");
    expect(html).toContain("Manage access");
    expect(html).not.toContain("Remove Ada Admin");
  });

  test("speaks German", () => {
    const html = render("write", "de");
    expect(html).toContain("Adressen");
    expect(html).toContain("Empfangsadresse");
    expect(html).toContain("Standardabsender");
    expect(html).toContain('aria-label="support@example.test kopieren"');
    expect(html).toContain("Dein Zugriff");
    expect(html).toContain(">Bearbeiten<");
    expect(html).toContain("Verbunden");
    expect(html).not.toContain("Zugriff verwalten");
  });
});
