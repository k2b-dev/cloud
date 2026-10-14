import { expect, test } from "bun:test";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory-settings";
import type { SenderIdentity } from "../../contracts";

if (!isServer)
  test("contact Commands read with current authority, never create a draft, and recover from denied access", async () => {
    const dom = createDomTestHarness();
    const { openCommand } = await import("@k2b/cloud/browser/commands");
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let denied = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/contacts/contact.read"))
          return denied
            ? Response.json({ code: "FORBIDDEN", message: "Not allowed" }, { status: 403 })
            : Response.json({
                data: {
                  id: "cont01",
                  bookId: "book01",
                  displayName: "Ada Example",
                  companyName: null,
                  jobTitle: null,
                  emails: [{ email: "ada@example.test", label: "Work" }],
                  phones: [],
                  updatedAt: "2026-08-18T12:00:00.000Z",
                },
              });
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailComposeIntentPage } = await import("./MailComposeIntentPage.island");
    delegateEvents(["click"]);
    const dispose = render(
      () => (
        <MailComposeIntentPage
          mailboxes={[{ id: "mail01", name: "Mailbox", description: null, canManage: false }]}
          initialMailboxId=""
          autoStart={false}
          mailto={null}
          returnHref={null}
          contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
          currentUserEmail={null}
        />
      ),
      dom.root,
    );
    const target = { command: "mail.compose", input: { contact: { type: "contacts.contact", id: "cont01" } } };
    try {
      await openCommand(target.command, target.input);
      expect(dom.root.textContent).toContain("ada@example.test");
      expect(calls).toEqual(["/api/capabilities/v1/queries/contacts/contact.read"]);
      denied = true;
      await openCommand(target.command, target.input);
      expect(dom.root.textContent).not.toContain("ada@example.test");
      expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("unavailable");
      denied = false;
      const retry = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        button.textContent?.includes("Retry"),
      );
      expect(retry).toBeDefined();
      retry!.click();
      for (let i = 0; i < 100 && !dom.root.textContent?.includes("ada@example.test"); i++) await Bun.sleep(10);
      expect(dom.root.textContent).toContain("ada@example.test");
      expect(calls).toHaveLength(3);
      expect(calls.every((url) => url.endsWith("/contacts/contact.read"))).toBe(true);
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    }
  });

const unverifiedIdentity = (statusReason: SenderIdentity["statusReason"]): SenderIdentity => ({
  id: "Send01",
  mailboxId: "mail01",
  label: "Support",
  displayName: "Support",
  fromAddress: "support@example.test",
  replyTo: null,
  defaultCc: [],
  defaultBcc: [],
  defaultFormat: "markdown",
  defaultPriority: "normal",
  defaultDeliveryReceipt: false,
  defaultReadReceipt: false,
  vcard: null,
  envelopeSender: null,
  defaultSignatureTemplateId: null,
  transport: {
    mode: "mailbox",
    host: null,
    port: null,
    tlsMode: null,
    username: null,
    secret: { kind: null, isSet: false },
    revision: 0,
    status: "active",
    capabilities: { dsn: false, size: false, maxMessageBytes: null },
    lastVerifiedAt: null,
    lastError: null,
  },
  authenticationPolicy: { automation: "mailbox" },
  sentFolderId: null,
  draftsFolderId: null,
  isDefault: true,
  status: "unverified",
  statusReason,
  pendingVerificationCommandId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

if (!isServer)
  test("a mailbox without a verified sender names the reason and leads admins to the sender settings", async () => {
    const dom = createDomTestHarness();
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/sender-identities")) return Response.json([unverifiedIdentity("sent_folder_missing")]);
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailComposeIntentPage } = await import("./MailComposeIntentPage.island");
    const renderPage = (canManage: boolean) =>
      render(
        () => (
          <MailComposeIntentPage
            mailboxes={[{ id: "mail01", name: "Mailbox", description: null, canManage }]}
            initialMailboxId="mail01"
            autoStart={false}
            mailto={null}
            returnHref={null}
            contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
            currentUserEmail={null}
          />
        ),
        dom.root,
      );
    const notice = async () => {
      for (let i = 0; i < 100 && !dom.root.querySelector("[data-mail-sender-unavailable]"); i++) await Bun.sleep(10);
      return dom.root.querySelector<HTMLElement>("[data-mail-sender-unavailable]");
    };
    try {
      let dispose = renderPage(true);
      let shown = await notice();
      expect(shown?.textContent).toContain("Support: Sent folder missing.");
      expect(Array.from(shown?.querySelectorAll("button") ?? []).map((button) => button.textContent)).toEqual(["Open sender settings"]);
      dispose();

      dispose = renderPage(false);
      shown = await notice();
      expect(shown?.textContent).toContain("Sent folder missing");
      expect(shown?.querySelector("button")).toBeNull();
      expect(shown?.textContent).toContain("Manage access");
      dispose();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      dom.cleanup();
    }
  });

if (!isServer)
  test("switching to another mailbox shows no sender notice while its senders load", async () => {
    const dom = createDomTestHarness();
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    const originalFetch = globalThis.fetch;
    const verified = (mailboxId: string): SenderIdentity => ({
      ...unverifiedIdentity(null),
      id: `Send-${mailboxId}`,
      mailboxId,
      status: "verified",
    });
    let releaseSecond!: () => void;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/mail01/sender-identities")) return Response.json([verified("mail01")]);
        if (url.includes("/mail02/sender-identities")) {
          await new Promise<void>((resolve) => {
            releaseSecond = resolve;
          });
          return Response.json([verified("mail02")]);
        }
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const { default: MailComposeIntentPage } = await import("./MailComposeIntentPage.island");
    delegateEvents(["click"]);
    const dispose = render(
      () => (
        <MailComposeIntentPage
          mailboxes={[
            { id: "mail01", name: "First", description: null, canManage: true },
            { id: "mail02", name: "Second", description: null, canManage: true },
          ]}
          initialMailboxId="mail01"
          autoStart={false}
          mailto={null}
          returnHref={null}
          contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
          currentUserEmail={null}
        />
      ),
      dom.root,
    );
    const waitFor = async (condition: () => boolean) => {
      for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(5);
      expect(condition()).toBe(true);
    };
    const notice = () => dom.root.querySelector("[data-mail-sender-unavailable]");
    try {
      await waitFor(() => dom.root.textContent?.includes("Support") ?? false);
      expect(notice()).toBeNull();

      const mailboxLabel = Array.from(dom.document.querySelectorAll("label")).find((label) => label.textContent === "Mailbox")!;
      (dom.document.getElementById(mailboxLabel.htmlFor) as HTMLElement).click();
      await waitFor(() => dom.document.querySelector('[role="option"]') !== null);
      Array.from(dom.document.querySelectorAll<HTMLElement>('[role="option"]'))
        .find((option) => option.textContent?.includes("Second"))!
        .click();
      await waitFor(() => typeof releaseSecond === "function");
      await Bun.sleep(20);
      expect(notice()).toBeNull();

      releaseSecond();
      await Bun.sleep(20);
      expect(notice()).toBeNull();
    } finally {
      dispose();
      globalThis.fetch = originalFetch;
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      dom.cleanup();
    }
  });
