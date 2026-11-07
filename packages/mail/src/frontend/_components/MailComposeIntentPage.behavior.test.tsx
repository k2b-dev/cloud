import { expect, spyOn, test } from "bun:test";
import { commandPath } from "@k2b/cloud/contracts";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../../contact-directory-settings";
import type { MailDraftSeed, SenderIdentity } from "../../contracts";

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
          currentUserId="Usr001"
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
            currentUserId="Usr001"
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
          currentUserId="Usr001"
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

const verifiedIdentity = (id: string, label: string): SenderIdentity => ({
  ...unverifiedIdentity(null),
  id,
  label,
  isDefault: false,
  status: "verified",
});

const intentSeed = (mailboxId: string, senderIdentityId: string): MailDraftSeed => ({
  id: "20000000-0000-4000-8000-000000000002",
  mailboxId,
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  content: {
    senderIdentityId,
    to: [{ name: null, address: "ada@example.test" }],
    cc: [],
    bcc: [],
    subject: "Hello",
    body: "",
    format: "markdown",
    priority: "normal",
    requestDeliveryReceipt: false,
    requestReadReceipt: false,
  },
  attachments: [],
  origin: { kind: "compose", input: { senderIdentityId, to: [], cc: [], bcc: [], subject: "", body: "" } },
  createdAt: "2026-11-06T10:00:00.000Z",
});

/** Renders the compose page against a fake Mail API and records each request and the final redirect. */
const renderIntentPage = async (
  props: {
    mailboxIds: string[];
    initialMailboxId: string;
    directIdentityId?: string | null;
    returnHref?: string | null;
    mailto?: string | null;
    /** A Command link the page opens with, as another app builds it. */
    commandLink?: string;
  },
  api: { identities?: SenderIdentity[]; seedStatus?: number } = {},
) => {
  const dom = createDomTestHarness();
  if (props.commandLink) dom.window.history.replaceState(null, "", props.commandLink);
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
  const replace = spyOn(dom.window.location, "replace").mockImplementation(() => {});
  const originalFetch = globalThis.fetch;
  const requests: Array<{ method: string; url: string; body: unknown }> = [];
  let releaseSeed = () => {};
  const seedGate = new Promise<void>((resolve) => {
    releaseSeed = resolve;
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(new URL(String(input), "http://localhost"), init);
      const url = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() : null;
      requests.push({ method: request.method, url, body });
      if (url.endsWith("/sender-identities")) return Response.json(api.identities ?? []);
      if (url.endsWith("/contacts/contact.read"))
        return Response.json({
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
      if (url.endsWith("/draft-seeds")) {
        await seedGate;
        const mailboxId = url.split("/").at(-2)!;
        const senderIdentityId = (body as { origin: { input: { senderIdentityId: string } } }).origin.input.senderIdentityId;
        return api.seedStatus
          ? Response.json({ code: "INTERNAL", message: "Mail is unavailable" }, { status: api.seedStatus })
          : Response.json(intentSeed(mailboxId, senderIdentityId));
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
        currentUserId="Usr001"
        mailboxes={props.mailboxIds.map((id) => ({ id, name: `Mailbox ${id}`, description: null, canManage: false }))}
        initialMailboxId={props.initialMailboxId}
        directIdentityId={props.directIdentityId}
        commandPending={Boolean(props.commandLink)}
        autoStart={false}
        mailto={props.mailto === undefined ? "mailto:ada@example.test?subject=Hello" : props.mailto}
        returnHref={props.returnHref ?? null}
        contactDirectory={DEFAULT_MAIL_CONTACT_DIRECTORY}
        currentUserEmail={null}
      />
    ),
    dom.root,
  );
  // The test's own timeout bounds the wait.
  const waitFor = async (condition: () => boolean) => {
    while (!condition()) await Bun.sleep(5);
  };
  return {
    dom,
    requests,
    replace,
    releaseSeed,
    waitFor,
    seedPosts: () => requests.filter((request) => request.url.endsWith("/draft-seeds")),
    labels: () => Array.from(dom.root.querySelectorAll("label")).map((label) => label.textContent),
    button: (name: string) =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes(name)),
    cleanup: () => {
      dispose();
      releaseSeed();
      globalThis.fetch = originalFetch;
      if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
      else delete (globalThis as { localStorage?: unknown }).localStorage;
      dom.cleanup();
    },
  };
};

if (!isServer)
  test("one mailbox with one sender opens its composer once, without a chooser, and Back returns to the origin", async () => {
    const page = await renderIntentPage({
      mailboxIds: ["mail01"],
      initialMailboxId: "mail01",
      directIdentityId: "Send01",
      returnHref: "/app/contacts?contact=cont01",
    });
    try {
      await page.waitFor(() => page.seedPosts().length === 1);
      expect(page.dom.root.textContent).toContain("Preparing message");
      expect(page.dom.root.querySelector("section")?.classList.contains("hidden")).toBe(true);
      // The server already chose the sender: the page asks for no sender list.
      expect(page.requests.map((request) => request.url)).toEqual(["/api/mail/mailboxes/mail01/draft-seeds"]);
      expect(page.seedPosts()[0]!.body).toMatchObject({
        origin: { input: { senderIdentityId: "Send01", to: [{ address: "ada@example.test" }], subject: "Hello" } },
      });

      page.releaseSeed();
      await page.waitFor(() => page.replace.mock.calls.length === 1);
      // Replacing the history entry keeps the intent page out of Back and makes a reload reopen the same local draft.
      const destination = new URL(String(page.replace.mock.calls[0]![0]), "http://localhost");
      expect(destination.pathname).toBe("/app/mail/mail01/compose/local/20000000-0000-4000-8000-000000000002");
      expect(destination.searchParams.get("return")).toBe("/app/contacts?contact=cont01");
      expect(localStorage.getItem("cloud:mail:last-sender:mail01")).toBe("Send01");
      await Bun.sleep(20);
      expect(page.seedPosts()).toHaveLength(1);
    } finally {
      page.cleanup();
    }
  });

if (!isServer)
  test("a failed direct start shows the choosers with the sender and does not start again on its own", async () => {
    const page = await renderIntentPage(
      { mailboxIds: ["mail01"], initialMailboxId: "mail01", directIdentityId: "Send01" },
      { identities: [verifiedIdentity("Send01", "Support")], seedStatus: 500 },
    );
    try {
      page.releaseSeed();
      await page.waitFor(() => page.dom.root.querySelector("section")?.classList.contains("hidden") === false);
      await page.waitFor(() => page.button("Continue")?.disabled === false);
      expect(page.dom.root.textContent).toContain("Support");
      await Bun.sleep(20);
      expect(page.seedPosts()).toHaveLength(1);
      expect(page.replace).not.toHaveBeenCalled();
    } finally {
      page.cleanup();
    }
  });

if (!isServer)
  test("one mailbox with two senders asks for the sender, starting from the remembered one, and a double click makes one draft", async () => {
    const page = await renderIntentPage(
      { mailboxIds: ["mail01"], initialMailboxId: "mail01", directIdentityId: null },
      { identities: [verifiedIdentity("Send01", "Support"), verifiedIdentity("Send02", "Sales")] },
    );
    localStorage.setItem("cloud:mail:last-sender:mail01", "Send02");
    try {
      await page.waitFor(() => page.button("Continue")?.disabled === false);
      expect(page.labels()).toEqual(["Mailbox", "from"]);
      expect(page.dom.root.textContent).toContain("Sales");
      expect(page.seedPosts()).toHaveLength(0);

      page.button("Continue")!.click();
      page.button("Continue")!.click();
      page.releaseSeed();
      await page.waitFor(() => page.replace.mock.calls.length === 1);
      expect(page.seedPosts()).toHaveLength(1);
      expect(page.seedPosts()[0]!.body).toMatchObject({ origin: { input: { senderIdentityId: "Send02" } } });
      expect(new URL(String(page.replace.mock.calls[0]![0]), "http://localhost").searchParams.get("return")).toBe("/app/mail/mail01");
    } finally {
      page.cleanup();
    }
  });

if (!isServer)
  test("two mailboxes ask for the mailbox and start nothing on their own", async () => {
    const page = await renderIntentPage({ mailboxIds: ["mail01", "mail02"], initialMailboxId: "" });
    try {
      await page.waitFor(() => page.labels().includes("Mailbox"));
      await Bun.sleep(20);
      expect(page.dom.root.textContent).toContain("Mailbox mail01Mailbox mail02");
      expect(page.button("Continue")?.disabled).toBe(true);
      expect(page.requests).toHaveLength(0);
    } finally {
      page.cleanup();
    }
  });

if (!isServer)
  test("a contact Command link with one mailbox and one sender opens the composer for the contact's address", async () => {
    const page = await renderIntentPage({
      mailboxIds: ["mail01"],
      initialMailboxId: "mail01",
      directIdentityId: "Send01",
      mailto: null,
      commandLink: commandPath("/app/mail/compose", "mail.compose", { contact: { type: "contacts.contact", id: "cont01" } }),
    });
    try {
      expect(page.dom.root.textContent).toContain("Preparing message");
      await page.waitFor(() => page.seedPosts().length === 1);
      expect(page.seedPosts()[0]!.body).toMatchObject({
        origin: { input: { senderIdentityId: "Send01", to: [{ address: "ada@example.test" }] } },
      });
      expect(page.requests.some((request) => request.url.endsWith("/sender-identities"))).toBe(false);
    } finally {
      page.cleanup();
    }
  });
