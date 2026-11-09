import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { MailDraft, MailDraftSeed, SenderIdentity } from "../contracts";
import type { MailboxPageData } from "../service/workspace";
import { mailComposeDraftSeedInput } from "./_components/mail-compose-seed";
import { mailTestFolder } from "./_components/mail-list-test-fixtures";

// Evaluate UI modules with a document, outside the individual tests' timeout.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return {
      shared: await import("@k2b/cloud/shared"),
      contacts: await import("../contact-directory-settings"),
      userPreferences: await import("./_components/mail-user-preferences"),
      workspacePreferences: await import("./_components/mail-workspace-preferences"),
      MailWorkspace: (await import("./MailWorkspace.island")).default,
      MailComposeIntentPage: (await import("./_components/MailComposeIntentPage.island")).default,
      nav: await import("@k2b/ssr/nav"),
      commands: await import("@k2b/cloud/browser/testing"),
      ui: await import("@k2b/ui"),
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const now = "2026-10-03T10:00:00.000Z";
const identity: SenderIdentity = {
  id: "Send01",
  mailboxId: "Box001",
  label: "Support",
  displayName: "Support",
  fromAddress: "support@example.com",
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
  status: "verified",
  statusReason: null,
  pendingVerificationCommandId: null,
  createdAt: now,
  updatedAt: now,
};
const seed: MailDraftSeed = {
  id: "20000000-0000-4000-8000-000000000002",
  mailboxId: "Box001",
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  content: {
    quoteSource: null,
    senderIdentityId: "Send01",
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    body: "",
    format: "markdown",
    priority: "normal",
    requestDeliveryReceipt: false,
    requestReadReceipt: false,
  },
  attachments: [],
  origin: { kind: "compose", input: { quoteSource: null, senderIdentityId: "Send01", to: [], cc: [], bcc: [], subject: "", body: "" } },
  createdAt: now,
};
/** The draft the server materializes from the seed: a new message starts in the flow, not on a compose page. */
const materializedDraft = (senderIdentityId: string): MailDraft => ({
  id: "Drf0New1",
  mailboxId: "Box001",
  conversationId: null,
  intent: "new",
  sourceMessageId: null,
  derivedFromMessageId: null,
  derivationKind: null,
  quoteSource: null,
  senderIdentityId,
  to: [],
  cc: [],
  bcc: [],
  subject: "",
  body: "",
  format: "markdown",
  priority: "normal",
  requestDeliveryReceipt: false,
  requestReadReceipt: false,
  attachments: [],
  suggestion: false,
  createdBy: { kind: "user", userId: "user-1" },
  lastEditedBy: { kind: "user", userId: "user-1" },
  lastEditedByDisplayName: "Reader",
  recoveryCopyCount: 0,
  revision: 1,
  state: "draft",
  deliveryClass: "normal",
  signatureTemplateId: null,
  createdAt: now,
  updatedAt: now,
});

const MAILBOX_ID = "Box001";

const data: MailboxPageData = {
  viewPreference: { large: "auto", phone: "compact" },
  doneTodayCounts: { doneToday: 0, doneByAutomation: 0 },
  receivingAddress: null,
  mailbox: {
    id: MAILBOX_ID,
    name: "Support",
    description: "",
    health: "active",
    healthReason: null,
    syncEnabled: true,
    searchBackend: "auto",
    automaticReplyManagementPermission: "admin",
    accessScope: "mailbox",
    draftEditMode: "lock",
    composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
    createdAt: now,
    updatedAt: now,
  },
  permission: "write",
  access: { scope: "mailbox", permission: "write" },
  initialLiveCursor: "s6t.mail.4",
  folders: [
    mailTestFolder("Inbox1", { role: "inbox", providerRole: "inbox", name: "Inbox" }),
    mailTestFolder("Filed1", { role: "custom", providerRole: "custom", name: "Filed" }),
    mailTestFolder("Drafts1", { role: "drafts", providerRole: "drafts", name: "Drafts", unread: 0 }),
    mailTestFolder("Trash1", { role: "trash", providerRole: "trash", name: "Trash", unread: 0 }),
  ],
  identities: [identity, { ...identity, id: "Send02", isDefault: false }],
  scheduledMode: false,
  scheduledCount: 0,
  scheduledPage: null,
  scheduledError: null,
  draftsMode: false,
  draftsPage: null,
  draftsError: null,
  eventsMode: false,
  eventsPage: null,
  eventsError: null,
  activeView: null,
  savedViewId: null,
  savedViews: [
    {
      id: "Saved1",
      mailboxId: MAILBOX_ID,
      name: "Priority",
      scope: "mailbox",
      ownerUserId: null,
      filter: { expression: { type: "work_status", value: "needs_action" }, sort: "newest" },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    },
  ],
  listMode: "conversations",
  folderId: null,
  viewCounts: { needs_action: 3, mine: 0, unassigned: 0, waiting: 0, done: 0, snoozed: 0, send_problems: 0, recently_active: 0, kept: 0 },
  query: "",
  search: { query: "", expression: null, sort: "relevance", error: null },
  selectedConversationId: null,
  selectedMessageId: null,
  listItems: [],
  listCursor: null,
  nextListCursor: null,
  listError: null,
  hiddenDone: null,
  assignedGroups: null,
  listTitle: "Needs action",
  conversationRowState: null,
  detailMessages: [],
  conversationSummary: null,
  conversationDrafts: [],
  automationTrace: [],
  detailError: null,
  collaborationState: null,
  localTags: [],
  conversationLocalTags: null,
  comments: [],
  commentsCursor: null,
  assignableUsers: [],
  activity: [],
  reminder: null,
  keep: null,
  collaborationError: null,
  detailErrors: {
    collaboration: null,
    tags: null,
    comments: null,
    assignableUsers: null,
    activity: null,
    reminder: null,
    keep: null,
    reference: null,
    summary: null,
    drafts: null,
  },
  selectedSubject: "",
  selectedReference: null,
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const waitFor = async (condition: () => boolean) => {
  const deadline = performance.now() + 2_000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for compose state");
    await Bun.sleep(1);
  }
};

describe.skipIf(isServer)("mailbox compose opens one new message", () => {
  const m = modules!;
  const path = "/app/mail/Box001";
  const intentHref = "/app/mail/compose?mailbox=Box001&autostart=1";
  const preferenceKey = "cloud:mail:last-sender:Box001";
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const navigationSpies = () => ({
    document: spyOn(m.nav, "documentNavigate").mockImplementation(() => {}),
    navigateTo: spyOn(m.nav, "navigateTo").mockImplementation(() => {}),
    assign: spyOn(dom.window.location, "assign").mockImplementation(() => {}),
    replace: spyOn(dom.window.location, "replace").mockImplementation(() => {}),
  });
  let dom: DomTestHarness;
  let navigation: ReturnType<typeof navigationSpies>;
  let dispose = () => {};
  let requests: Array<{ path: string; method: string; body: unknown }>;
  let identities: SenderIdentity[];
  let responseGate: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
  let failure: string | null;
  let materializeFailure: string | null;

  beforeEach(() => {
    setSystemTime(new Date(now));
    dom = createDomTestHarness();
    document.documentElement.lang = "en";
    Object.defineProperty(globalThis, "CSS", { configurable: true, value: dom.window.CSS });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: dom.window.localStorage });
    Reflect.set(globalThis, "WebSocket", FakeWebSocket);
    dom.window.history.replaceState(null, "", path);
    navigation = navigationSpies();
    requests = [];
    identities = structuredClone(data.identities);
    responseGate = undefined;
    failure = null;
    materializeFailure = null;
    dispose = () => {};
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        const request = new Request(input instanceof Request ? input : url, init);
        const recorded: (typeof requests)[number] = { path: url.pathname, method: request.method, body: null };
        requests.push(recorded);
        const raw = await request.text();
        recorded.body = raw ? JSON.parse(raw) : null;
        if (url.pathname === "/api/mail/mailboxes/Box001/draft-seeds" && request.method === "POST") {
          if (responseGate) return responseGate.promise;
          return failure ? Response.json({ code: "DRAFT_FAILED", message: failure }, { status: 500 }) : Response.json(seed);
        }
        if (url.pathname === "/api/mail/mailboxes/Box001/draft-seeds/materialize" && request.method === "POST") {
          if (materializeFailure) return Response.json({ code: "DRAFT_FAILED", message: materializeFailure }, { status: 500 });
          return Response.json(materializedDraft((recorded.body as { draft: { senderIdentityId: string } }).draft.senderIdentityId));
        }
        // What the inline draft loads beside the materialized draft.
        if (url.pathname.endsWith("/attachment-uploads") || url.pathname.endsWith("/compose-templates")) return Response.json([]);
        if (url.pathname.endsWith("/compose-signature-defaults")) return Response.json([]);
        if (url.pathname.endsWith("/sender-identities")) return Response.json(identities);
        if (url.pathname.endsWith("/activity")) return Response.json({ items: [], nextCursor: null });
        throw new Error(`Unexpected fetch: ${request.method} ${url.pathname}`);
      },
      { preconnect: originalFetch.preconnect },
    );
  });

  afterEach(async () => {
    responseGate?.resolve(Response.json(seed));
    m.ui.dialogCore.close();
    dispose();
    m.ui.toast.dismissAll();
    // Finish queued DOM work before restoring the document and network boundary.
    await dom.window.happyDOM.waitUntilComplete();
    for (const spy of Object.values(navigation)) spy.mockRestore();
    globalThis.fetch = originalFetch;
    Reflect.set(globalThis, "WebSocket", originalWebSocket);
    dom.cleanup();
    for (const [key, descriptor] of [
      ["CSS", originalCss],
      ["localStorage", originalStorage],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    setSystemTime();
  });

  const mount = () => {
    dispose = render(
      () =>
        createComponent(m.MailWorkspace, {
          data: { ...structuredClone(data), identities },
          requestPath: path,
          currentUserId: "user-1",
          currentUserEmail: "reader@example.test",
          contactDirectory: m.contacts.DEFAULT_MAIL_CONTACT_DIRECTORY,
          cloudUrl: "https://cloud.example",
          dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
          initialPreferences: m.workspacePreferences.readMailWorkspacePreferences(""),
          initialUserPreferences: m.userPreferences.readMailUserPreferencesFromCookieHeader("", MAILBOX_ID),
          initialTheme: m.shared.readThemeFromCookieHeader(""),
          calendarIntegrationAvailable: false,
          sidebar: {
            mailboxes: [{ ...data.mailbox, receivingAddress: data.receivingAddress }],
            pinnedMailboxIds: [],
            hiddenMailboxIds: [],
          },
        }),
      dom.root,
    );
  };
  const composeLink = () => dom.root.querySelector<HTMLAnchorElement>("[data-workspace-primary]")!;
  /** Draft creation only; the opened draft's own lease and saves are the composer's business. */
  const posts = () => requests.filter((request) => request.method === "POST" && request.path.includes("/draft-seeds"));
  const runComposeCommand = () => {
    const command = m.commands.contextCommandsWithShortcuts().find((command) => command.id === "mail.compose");
    expect(command).toMatchObject({ id: "mail.compose", title: "New email", shortcut: "mod+alt+n" });
    if (typeof command?.action !== "function") throw new Error("Missing compose command action");
    return command.action();
  };
  const seedPost = (sender: string) => ({
    path: "/api/mail/mailboxes/Box001/draft-seeds",
    method: "POST",
    body: mailComposeDraftSeedInput(sender),
  });
  const materializePath = "/api/mail/mailboxes/Box001/draft-seeds/materialize";
  /** v4: Compose creates the draft (seed, then materialize) and opens it as "New message" in the flow, on this page. */
  const expectNewMessage = async (sender = "Send01") => {
    await waitFor(() => new URL(window.location.href).searchParams.get("draft") === "Drf0New1");
    expect(posts().map(({ path }) => path)).toEqual([seedPost(sender).path, materializePath]);
    expect(posts()[0]).toEqual(seedPost(sender));
    expect((posts()[1]!.body as { idempotencyKey: string }).idempotencyKey).toBe(seed.id);
    await waitFor(() => dom.root.querySelector("[data-mail-new-message-row]") !== null);
    expect(navigation.document).not.toHaveBeenCalled();
    expect(navigation.navigateTo).not.toHaveBeenCalled();
    expect(navigation.assign).not.toHaveBeenCalled();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe(path);
    expect(localStorage.getItem(preferenceKey)).toBe(sender);
  };
  const dialog = () => dom.document.querySelector('dialog[open][aria-label="Could not start message"]');
  const expectFailure = async (reason: string) => {
    await waitFor(() => dialog()?.textContent?.includes(reason) === true);
    expect(dialog()?.textContent).toContain("Could not start message");
    expect(navigation.document).not.toHaveBeenCalled();
    expect(navigation.navigateTo).not.toHaveBeenCalled();
    expect(composeLink().hasAttribute("aria-busy")).toBe(false);
  };

  test("a1 desktop head Compose creates one draft and opens it as a new message in the flow", async () => {
    mount();
    expect(composeLink().getAttribute("href")).toBe(intentHref);
    composeLink().click();
    await expectNewMessage();
  });

  test("a2 phone head Compose shows progress while preparing and opens one new message", async () => {
    dom.window.innerWidth = 375;
    dom.window.innerHeight = 740;
    mount();
    const link = composeLink();
    expect(link.getAttribute("href")).toBe(intentHref);
    responseGate = Promise.withResolvers<Response>();
    link.click();
    await waitFor(() => posts().length === 1);
    expect(link.querySelector(".ti-loader-2")).not.toBeNull();
    expect(navigation.document).not.toHaveBeenCalled();
    responseGate.resolve(Response.json(seed));
    await expectNewMessage();
  });

  test("a3 mail.compose retains its shortcut and opens one new message", async () => {
    mount();
    runComposeCommand();
    await expectNewMessage();
  });

  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    test(`b1 modified desktop click stays native: ${JSON.stringify(modifiers)}`, () => {
      mount();
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifiers });
      composeLink().dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      if (modifiers.button === 1) {
        const auxiliary = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 });
        composeLink().dispatchEvent(auxiliary);
        expect(auxiliary.defaultPrevented).toBe(false);
      }
      expect(posts()).toEqual([]);
      expect(navigation.document).not.toHaveBeenCalled();
      expect(navigation.navigateTo).not.toHaveBeenCalled();
    });
  }

  for (const unavailable of [[], [{ ...identity, status: "unverified" as const, statusReason: "verification_required" as const }]]) {
    test(`b2 ${unavailable.length ? "unverified" : "absent"} sender falls back and the intent page explains why`, async () => {
      identities = unavailable;
      mount();
      composeLink().click();
      await waitFor(() => navigation.document.mock.calls.length === 1);
      const target = new URL(navigation.document.mock.calls[0]![0], "http://localhost");
      expect(target.pathname + target.search).toBe(intentHref);
      runComposeCommand();
      expect(navigation.navigateTo).toHaveBeenCalledTimes(1);
      expect(navigation.navigateTo).toHaveBeenCalledWith(intentHref);
      expect(posts()).toEqual([]);
      dispose();
      dom.window.history.replaceState(null, "", intentHref);
      dispose = render(
        () =>
          createComponent(m.MailComposeIntentPage, {
            mailboxes: [{ id: MAILBOX_ID, name: "Support", description: null, canManage: false }],
            initialMailboxId: MAILBOX_ID,
            autoStart: true,
            mailto: null,
            returnHref: null,
            contactDirectory: m.contacts.DEFAULT_MAIL_CONTACT_DIRECTORY,
            cloudUrl: "https://cloud.example",
            currentUserEmail: null,
          }),
        dom.root,
      );
      await waitFor(() => dom.root.querySelector("[data-mail-sender-unavailable]") !== null);
      const notice = dom.root.querySelector("[data-mail-sender-unavailable]")!;
      expect(notice.textContent).toContain("This mailbox cannot send yet");
      expect(notice.textContent).toContain(unavailable.length ? "Not verified" : "It has no sender identity. Add one and verify it.");
      expect(requests.filter((request) => request.path.endsWith("/sender-identities"))).toHaveLength(1);
      expect(posts()).toEqual([]);
      expect(navigation.document).toHaveBeenCalledTimes(1);
    });
  }

  test("b3 a failed draft POST reports its reason, clears pending, and allows retry", async () => {
    mount();
    failure = "Draft preparation unavailable";
    runComposeCommand();
    await expectFailure(failure);
    await waitFor(() => dom.document.querySelector("[data-k2b-toast-container]")?.childElementCount === 0);
    expect(posts()).toHaveLength(1);
    m.ui.dialogCore.close();
    failure = null;
    composeLink().click();
    await waitFor(() => new URL(window.location.href).searchParams.get("draft") === "Drf0New1");
    expect(posts()).toEqual([seedPost("Send01"), seedPost("Send01"), expect.objectContaining({ path: materializePath })]);
    expect(navigation.document).not.toHaveBeenCalled();
  });

  test("b7 a failed materialize reports its reason and the retry finishes the same seed, never a second one", async () => {
    mount();
    materializeFailure = "Draft storage unavailable";
    composeLink().click();
    await expectFailure(materializeFailure);
    m.ui.dialogCore.close();
    materializeFailure = null;
    composeLink().click();
    await waitFor(() => new URL(window.location.href).searchParams.get("draft") === "Drf0New1");
    expect(posts().map(({ path }) => path)).toEqual([seedPost("Send01").path, materializePath, materializePath]);
    expect(
      posts()
        .filter(({ path }) => path === materializePath)
        .map(({ body }) => (body as { idempotencyKey: string }).idempotencyKey),
    ).toEqual([seed.id, seed.id]);
  });

  for (const second of ["click", "command"]) {
    test(`b4 click then ${second} while preparing creates only one seed and one new message`, async () => {
      mount();
      responseGate = Promise.withResolvers<Response>();
      composeLink().click();
      if (second === "click") composeLink().click();
      else runComposeCommand();
      await waitFor(() => posts().length > 0);
      expect(posts()).toHaveLength(1);
      expect(navigation.document).not.toHaveBeenCalled();
      responseGate.resolve(Response.json(seed));
      await expectNewMessage();
      expect(dom.root.querySelectorAll("[data-mail-new-message-row]")).toHaveLength(1);
    });
  }

  for (const [preferred, expected] of [
    ["Send02", "Send02"],
    ["Gone01", "Send01"],
    ["Send03", "Send01"],
  ]) {
    test(`b5 sender preference ${preferred} selects ${expected}`, async () => {
      identities.push({ ...identity, id: "Send03", status: "unverified", isDefault: false });
      localStorage.setItem(preferenceKey, preferred!);
      mount();
      composeLink().click();
      await expectNewMessage(expected);
    });
  }

  test("b6 pending swaps only the icon on the same Compose element and announces it", async () => {
    mount();
    const link = composeLink();
    const before = { classes: link.className, text: link.textContent, children: link.childElementCount };
    expect(link.querySelector(".ti-pencil")).not.toBeNull();
    responseGate = Promise.withResolvers<Response>();
    link.click();
    await waitFor(() => posts().length === 1);
    expect(composeLink()).toBe(link);
    // The head's primary action has no busy state of its own; the live region says that the message is being prepared.
    await waitFor(() => dom.document.querySelector("[data-k2b-live]")?.textContent?.includes("Preparing message...") ?? false);
    expect(link.querySelector(".ti-loader-2")).not.toBeNull();
    expect(link.querySelector(".ti-pencil")).toBeNull();
    expect({ classes: link.className, text: link.textContent, children: link.childElementCount }).toEqual(before);
    responseGate.resolve(Response.json({ code: "DRAFT_FAILED", message: "Try later" }, { status: 500 }));
    await expectFailure("Try later");
    expect(composeLink()).toBe(link);
    expect(link.querySelector(".ti-pencil")).not.toBeNull();
    expect(link.querySelector(".ti-loader-2")).toBeNull();
    expect({ classes: link.className, text: link.textContent, children: link.childElementCount }).toEqual(before);
  });
});
