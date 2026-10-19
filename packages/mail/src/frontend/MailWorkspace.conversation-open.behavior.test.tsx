import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { resolveMailSearchRoute } from "../search-state";
import type { MailboxListView, MailboxPageData, MailConversationDetailData, MailListItem } from "../service/workspace";
import { mailTestFolder, mailTestRow } from "./_components/mail-list-test-fixtures";

// Load once outside any test, so the cold Solid transform of the workspace's source graph does not count against the
// 5 s test timeout. The @k2b/ui browser build needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    const { readThemeFromCookieHeader } = await import("@k2b/cloud/shared");
    const { DEFAULT_MAIL_CONTACT_DIRECTORY } = await import("../contact-directory-settings");
    const { readMailUserPreferencesFromCookieHeader } = await import("./_components/mail-user-preferences");
    const { readMailWorkspacePreferences } = await import("./_components/mail-workspace-preferences");
    const { default: MailWorkspace } = await import("./MailWorkspace.island");
    return {
      readThemeFromCookieHeader,
      DEFAULT_MAIL_CONTACT_DIRECTORY,
      readMailUserPreferencesFromCookieHeader,
      readMailWorkspacePreferences,
      MailWorkspace,
    };
  } finally {
    dom.cleanup();
  }
};
const modules = isServer ? undefined : await load();

const MAILBOX_ID = "Box001";
const FOLDER = "Inbox1";
const now = "2026-10-03T10:00:00.000Z";
const path = `/app/mail/${MAILBOX_ID}`;
const folderPath = `${path}?folder=${FOLDER}`;

const emptyDetailErrors: MailboxPageData["detailErrors"] = {
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
};

const message = (id: string, subject: string, text: string): MailboxPageData["detailMessages"][number] => ({
  id,
  subject,
  messageId: `<${id}@example.test>`,
  internalDate: now,
  sentAt: now,
  from: [{ name: "Sender", address: "sender@example.test" }],
  to: [],
  preview: "",
  hasAttachments: false,
  replyTo: [],
  cc: [],
  flags: ["\\Seen"],
  keywords: [],
  hydrationStatus: "complete",
  remoteAvailable: true,
  folderId: FOLDER,
  deletedOnServer: false,
  contentType: "text/plain",
  sizeBytes: 64,
  plainText: text,
  sanitizedHtml: null,
  forwardText: text,
  selectedHeaders: {},
  sourceAvailable: true,
  mailingList: null,
  remoteContent: { imageIds: [], allowedByRule: false, sender: "sender@example.test", domain: "example.test" },
  delivery: null,
  attachments: [],
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send() {}
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const rowId = (index: number) => `c${String(index).padStart(3, "0")}`;
/** Two list pages of 50 rows each. */
const PAGES: Record<string, { rows: string[]; next: string | null }> = {
  first: { rows: Array.from({ length: 50 }, (_, index) => rowId(index + 1)), next: "c2" },
  c2: { rows: Array.from({ length: 50 }, (_, index) => rowId(index + 51)), next: null },
};
const A = rowId(3);
/** On page 2, filed in another folder than the one the list shows. */
const B = rowId(60);

/** Polls an observable state with a bounded deadline. */
const until = async (condition: () => boolean, label: string) => {
  // The tests pin the system time, so the deadline runs on the monotonic clock.
  const deadline = performance.now() + 2_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
};
/** Long enough for a request that should not happen to show up. */
const settle = () => Bun.sleep(60);

describe("Mail workspace conversation open", () => {
  if (isServer) {
    test.skip("runs in the browser-conditions process", () => {});
    return;
  }
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  let dom: DomTestHarness;
  let dispose = () => {};
  let routeRequests: string[];
  let listRequests: string[];
  let detailRequests: { id: string; folder: string | null }[];
  let detailSignals: (AbortSignal | undefined)[];
  let actionRequests: { conversationId: string; body: unknown }[];
  /** Conversations still unread on the server. */
  let unread: Set<string>;
  /** Extra messages that arrived in a conversation after the page loaded. */
  let replies: Map<string, string>;
  /** Conversation revisions on the server; rows and details carry them. */
  let revisions: Map<string, number>;
  /** Conversations with a flagged message on the server. */
  let flagged: Set<string>;
  /** Conversations with a second message that lies unread and flagged only in Archive. */
  let elsewhere: Set<string>;
  /** Conversations whose messages were moved to Archive on the server after the list loaded. */
  let moved: Set<string>;
  /** The mailbox's tags on the server. */
  let mailboxTags: MailboxPageData["localTags"];
  /** Holds a detail response until the test releases it. */
  let detailGate: Map<string, Promise<void>>;
  let detailStatus: (id: string) => number;
  /** Holds every workspace-route response until the test releases it. */
  let routeGate: Promise<void> | undefined;
  /** Decides each workspace-route response's status, possibly later. */
  let routeStatus: (href: string) => number | Promise<number>;

  const row = (id: string): MailListItem =>
    mailTestRow(id, {
      subject: `Subject ${id}`,
      unread: unread.has(id),
      unreadFolderIds: unread.has(id) ? [FOLDER] : [],
      activeFolderIds: [id === B ? "Archive1" : FOLDER],
      sourceFolderId: id === B ? "Archive1" : id === A ? null : FOLDER,
      workStatus: null,
      revision: revisions.get(id) ?? 1,
      flagged: flagged.has(id),
      messageCount: elsewhere.has(id) ? 2 : 1,
    });
  const listFor = (href: string): MailboxListView => {
    const url = new URL(href, "http://localhost");
    const cursor = url.searchParams.get("cursor");
    const page = PAGES[cursor ?? "first"]!;
    return {
      scheduledMode: false,
      scheduledPage: null,
      scheduledError: null,
      draftsMode: false,
      draftsPage: null,
      draftsError: null,
      activeView: url.searchParams.has("view") ? "needs_action" : null,
      savedViewId: null,
      listMode: "conversations",
      folderId: url.searchParams.has("view") ? null : FOLDER,
      query: resolveMailSearchRoute(url).query,
      search: resolveMailSearchRoute(url),
      listItems: page.rows.map(row),
      listCursor: cursor,
      nextListCursor: page.next,
      listError: null,
      listTitle: "Inbox",
    };
  };
  const detailFor = (conversationId: string): MailConversationDetailData => {
    const reply = replies.get(conversationId);
    return {
      conversationId,
      localTags: mailboxTags,
      selectedSubject: `Subject ${conversationId}`,
      detailMessages: [
        // An older message, so the reader still opens on the conversation's own body.
        ...(elsewhere.has(conversationId)
          ? [{ ...message(`a-${conversationId}`, `Subject ${conversationId}`, "Filed away"), flags: ["\\Flagged"], folderId: "Archive1" }]
          : []),
        {
          ...message(`m-${conversationId}`, `Subject ${conversationId}`, `Body of ${conversationId}`),
          flags: [...(unread.has(conversationId) ? [] : ["\\Seen"]), ...(flagged.has(conversationId) ? ["\\Flagged"] : [])],
          // B lies in Archive only, and the detail prefers the row's folder for each message.
          folderId: conversationId === B || moved.has(conversationId) ? "Archive1" : FOLDER,
        },
        ...(reply ? [message(`r-${conversationId}`, `Subject ${conversationId}`, reply)] : []),
      ],
      conversationSummary: null,
      conversationDrafts: [],
      detailError: null,
      collaborationState: null,
      conversationLocalTags: { conversationId, conversationRevision: revisions.get(conversationId) ?? 1, tags: [] },
      comments: [],
      commentsCursor: null,
      assignableUsers: [],
      activity: [],
      reminder: null,
      keep: null,
      collaborationError: null,
      detailErrors: emptyDetailErrors,
      selectedReference: null,
    };
  };
  const snapshotFor = (href: string): MailboxPageData => {
    const conversation = new URL(href, "http://localhost").searchParams.get("conversation");
    const {
      conversationId: _,
      localTags,
      ...selection
    } = conversation ? detailFor(conversation) : { ...detailFor("none"), detailMessages: [], selectedSubject: "" };
    const unreadCount = unread.size;
    return {
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
        composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
        createdAt: now,
        updatedAt: now,
      },
      permission: "write",
      access: { scope: "mailbox", permission: "write" },
      initialLiveCursor: "s6t.mail.4",
      folders: [
        mailTestFolder(FOLDER, { role: "inbox", providerRole: "inbox", name: "Inbox", unread: unreadCount, total: 100 }),
        mailTestFolder("Archive1", { role: "archive", providerRole: "archive", name: "Archive", unread: 0, total: 1 }),
        mailTestFolder("Trash1", { role: "trash", providerRole: "trash", name: "Trash", unread: 0 }),
      ],
      identities: [],
      scheduledCount: 0,
      savedViews: [],
      viewCounts: {
        needs_action: 0,
        mine: 0,
        unassigned: 0,
        waiting: 0,
        done: 0,
        snoozed: 0,
        send_problems: 0,
        recently_active: 0,
        kept: 0,
      },
      ...listFor(href),
      selectedConversationId: conversation,
      selectedMessageId: null,
      localTags,
      ...selection,
    };
  };

  beforeEach(() => {
    setSystemTime(new Date(now));
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "CSS", { value: dom.window.CSS, configurable: true });
    FakeWebSocket.instances = [];
    Reflect.set(globalThis, "WebSocket", FakeWebSocket);
    routeRequests = [];
    listRequests = [];
    detailRequests = [];
    detailSignals = [];
    actionRequests = [];
    unread = new Set();
    replies = new Map();
    revisions = new Map();
    flagged = new Set();
    elsewhere = new Set();
    moved = new Set();
    mailboxTags = [];
    detailGate = new Map();
    detailStatus = () => 200;
    routeGate = undefined;
    routeStatus = () => 200;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        const href = url.searchParams.get("href") ?? "";
        if (url.pathname.endsWith("/workspace-route")) {
          routeRequests.push(href);
          // The server reads the snapshot when the request arrives; a held response arrives later with that data.
          const snapshot = snapshotFor(href);
          await routeGate;
          const status = await routeStatus(href);
          return status === 200 ? Response.json(snapshot) : Response.json({ error: "unavailable" }, { status });
        }
        if (url.pathname.endsWith("/workspace-list")) {
          listRequests.push(href);
          return Response.json(listFor(href));
        }
        const detail = /\/workspace-detail\/([^/]+)$/.exec(url.pathname);
        if (detail) {
          const id = detail[1]!;
          detailRequests.push({ id, folder: url.searchParams.get("folder") });
          detailSignals.push(input instanceof Request ? input.signal : (init?.signal ?? undefined));
          // The server reads the detail when the request arrives; a held response arrives later with that data.
          const body = detailFor(id);
          await detailGate.get(id);
          const status = detailStatus(id);
          return status === 200 ? Response.json(body) : Response.json({ error: "unavailable" }, { status });
        }
        if (url.pathname.endsWith("/actions")) {
          const conversationId = url.pathname.split("/conversations/")[1]!.split("/")[0]!;
          const body = JSON.parse(input instanceof Request ? await input.clone().text() : String(init?.body ?? "{}"));
          actionRequests.push({ conversationId, body });
          if (body.kind === "change_state" && body.change?.addFlags?.includes("seen")) unread.delete(conversationId);
          return Response.json({ commands: [{ id: `cmd-${actionRequests.length}`, state: "queued" }] });
        }
        if (url.pathname.endsWith("/commands/outcomes")) return Response.json([]);
        if (url.pathname.endsWith("/activity")) return Response.json({ items: [], nextCursor: null });
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
  });
  afterEach(async () => {
    const { toast, dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    dispose();
    toast.dismissAll();
    await Bun.sleep(20);
    globalThis.fetch = originalFetch;
    Reflect.set(globalThis, "WebSocket", originalWebSocket);
    dom.cleanup();
    if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
    else Reflect.deleteProperty(globalThis, "CSS");
    setSystemTime();
  });
  const mount = (href = folderPath) => {
    dom.window.history.replaceState(null, "", href);
    const m = modules!;
    dispose = render(
      () =>
        createComponent(m.MailWorkspace, {
          data: snapshotFor(href),
          requestPath: href,
          currentUserId: "user-1",
          currentUserEmail: "reader@example.test",
          contactDirectory: m.DEFAULT_MAIL_CONTACT_DIRECTORY,
          dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
          initialPreferences: m.readMailWorkspacePreferences(""),
          initialUserPreferences: m.readMailUserPreferencesFromCookieHeader("", MAILBOX_ID),
          initialTheme: m.readThemeFromCookieHeader(""),
          calendarIntegrationAvailable: false,
        }),
      dom.root,
    );
  };
  const rows = () => [...dom.root.querySelectorAll<HTMLElement>("[data-mail-conversation-list] [data-conversation-id]")];
  const rowLink = (id: string) => dom.root.querySelector<HTMLAnchorElement>(`[data-conversation-id="${id}"] .mail-list-row`)!;
  /** A pointer click reports its click count; Enter on a link reports 0. */
  const open = (id: string, activation: "pointer" | "keyboard" = "pointer") =>
    rowLink(id).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: activation === "pointer" ? 1 : 0 }),
    );
  const heading = () => dom.root.querySelector<HTMLElement>("[data-mail-reader-heading]")?.textContent ?? null;
  const shows = (id: string) => heading() === `Subject ${id}` && dom.document.body.textContent?.includes(`Body of ${id}`) === true;
  const loadSecondPage = async () => {
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${folderPath}&cursor=c2"]`)!.click();
    await until(() => rows().length === 100, "page 2");
    listRequests = [];
  };
  const selected = () => new URL(dom.window.location.href).searchParams.get("conversation");
  const inboxLink = () =>
    [...dom.root.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.getAttribute("href") === folderPath)?.textContent;

  test("opening conversations in the same list loads only their detail and keeps every loaded row", async () => {
    mount();
    await loadSecondPage();
    const before = rows();

    open(A);
    await until(() => shows(A), "conversation A");
    // The list does not depend on the selection: page 2 stays loaded.
    expect(rows()).toHaveLength(100);
    open(B);
    await until(() => shows(B), "conversation B");
    // The row's own folder decides the message folder attribution; a row without one uses the list's folder.
    expect(detailRequests).toEqual([
      { id: A, folder: FOLDER },
      { id: B, folder: "Archive1" },
    ]);
    expect(selected()).toBe(B);
    expect(rows()).toHaveLength(100);
    expect(rows().every((element, index) => element === before[index])).toBe(true);

    dom.window.history.back();
    await until(() => shows(A), "conversation A after Back");
    expect(selected()).toBe(A);
    dom.window.history.forward();
    await until(() => shows(B), "conversation B after Forward");

    dom.root.querySelector<HTMLAnchorElement>('a[aria-label="Back to conversation list"]')!.click();
    await until(() => heading() === null, "the closed reader");
    await settle();
    expect(selected()).toBeNull();
    expect(dom.document.activeElement).toBe(rowLink(B));
    expect(rows().every((element, index) => element === before[index])).toBe(true);
    expect(routeRequests).toEqual([]);
    expect(listRequests).toEqual([]);
    expect(detailRequests.map((request) => request.id)).toEqual([A, B, A, B]);
  });

  test("Back to a list that starts at a cursor loads that list again", async () => {
    mount(`${folderPath}&cursor=c2`);
    expect(rows()[0]?.dataset.conversationId).toBe(rowId(51));
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${folderPath}"]`)!.click();
    await until(() => rows()[0]?.dataset.conversationId === rowId(1), "the folder's first page");
    dom.window.history.back();
    await until(() => rows()[0]?.dataset.conversationId === rowId(51), "the list from the cursor");
    expect(routeRequests).toEqual([folderPath, `${folderPath}&cursor=c2`]);
  });

  test("a slower earlier response never replaces a later selection", async () => {
    mount();
    let releaseA = () => {};
    detailGate.set(
      A,
      new Promise<void>((resolve) => {
        releaseA = resolve;
      }),
    );
    open(A);
    await until(() => detailRequests.length === 1, "the request for A");
    open(rowId(10));
    await until(() => shows(rowId(10)), "the later conversation");
    releaseA();
    await settle();
    expect(shows(rowId(10))).toBe(true);
    expect(selected()).toBe(rowId(10));
    expect(routeRequests).toEqual([]);
  });

  test("loading another page keeps a detail that is newer than page 1", async () => {
    mount(`${folderPath}&conversation=${A}`);
    // A live refresh stores a page 1 that carries A as it was then.
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: A } });
    await until(() => routeRequests.length === 1, "the live refresh");
    await settle();
    expect(shows(A)).toBe(true);
    replies.set(A, "A newer reply");
    open(rowId(10));
    await until(() => shows(rowId(10)), "the other conversation");
    open(A);
    await until(() => dom.document.body.textContent?.includes("A newer reply") === true, "the newer detail");
    await loadSecondPage();
    expect(shows(A)).toBe(true);
    expect(dom.document.body.textContent).toContain("A newer reply");
    // The reply also makes A's row older than its detail, so page 1 reloads once with A open.
    expect(routeRequests).toEqual([`${folderPath}&conversation=${A}`, `${folderPath}&conversation=${A}`]);
  });

  test("a refresh requested before a newer detail open keeps that detail", async () => {
    mount(`${folderPath}&conversation=${A}`);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    let release = () => {};
    routeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: rowId(1) } });
    await until(() => routeRequests.length === 1, "the held refresh");
    replies.set(A, "A newer reply");
    open(rowId(10));
    await until(() => shows(rowId(10)), "the other conversation");
    open(A);
    await until(() => dom.document.body.textContent?.includes("A newer reply") === true, "the newer detail");
    release();
    await settle();
    expect(shows(A)).toBe(true);
    expect(dom.document.body.textContent).toContain("A newer reply");
    expect(selected()).toBe(A);
  });

  test("a live change to a conversation while its detail loads reaches the reader", async () => {
    mount();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    let release = () => {};
    detailGate.set(
      rowId(10),
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    open(rowId(10));
    await until(() => detailRequests.length === 1, "the held detail");
    replies.set(rowId(10), "A reply during the open");
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: rowId(10) } });
    await until(() => routeRequests.length === 1, "the live refresh");
    release();
    await until(() => dom.document.body.textContent?.includes("A reply during the open") === true, "the reply");
    expect(routeRequests.at(-1)).toBe(`${folderPath}&conversation=${rowId(10)}`);
    expect(shows(rowId(10))).toBe(true);
  });

  test("a refresh failure after the catch-up of a changed conversation says so", async () => {
    mount();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    let release = () => {};
    detailGate.set(
      rowId(10),
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    open(rowId(10));
    await until(() => detailRequests.length === 1, "the held detail");
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: rowId(10) } });
    await until(() => routeRequests.length === 1, "the live refresh");
    await settle();
    routeStatus = () => 503;
    release();
    await until(() => routeRequests.length === 2, "the catch-up refresh");
    await until(() => dom.document.body.textContent?.includes("Could not refresh this mailbox yet") === true, "the failure notice");
    expect(shows(rowId(10))).toBe(true);
  });

  test("an older refresh that lands during a view reload keeps the shown conversation's route", async () => {
    mount(`${folderPath}&conversation=${A}`);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    const held: Array<(status: number) => void> = [];
    routeStatus = () => new Promise<number>((resolve) => held.push(resolve));
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: rowId(1) } });
    await until(() => held.length === 1, "the held live refresh");
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${folderPath}"]`)!.click();
    held[0]!(200);
    await until(() => held.length === 2, "the held view reload");
    expect(shows(A)).toBe(true);
    held[1]!(503);
    await until(() => dom.document.body.textContent?.includes("Could not open this mailbox view") === true, "the failure notice");
    routeStatus = () => 200;
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.6", data: { conversationId: rowId(1) } });
    await until(() => routeRequests.length === 3, "the next live refresh");
    await settle();
    expect(routeRequests.at(-1)).toBe(`${folderPath}&conversation=${A}`);
    expect(shows(A)).toBe(true);
    expect(selected()).toBe(A);
  });

  test("returning to the shown folder while another view loads waits for that folder's own page 1", async () => {
    mount();
    open(A);
    await until(() => shows(A), "conversation A");
    const held: Array<(status: number) => void> = [];
    routeStatus = () => new Promise<number>((resolve) => held.push(resolve));
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${path}?view=needs_action"]`)!.click();
    await until(() => held.length === 1, "the held view switch");
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${folderPath}"]`)!.click();
    await until(() => held.length === 2, "the held return to the folder");
    await settle();
    expect(selected()).toBe(A);
    held[1]!(503);
    await until(() => dom.document.body.textContent?.includes("Could not open this mailbox view") === true, "the failure notice");
    expect(selected()).toBe(A);
    expect(shows(A)).toBe(true);
    held[0]!(200);
  });

  test("switching views while a row refresh loads ends that refresh without a failure notice", async () => {
    mount();
    const held: Array<(status: number) => void> = [];
    routeStatus = () => new Promise<number>((resolve) => held.push(resolve));
    revisions.set(rowId(22), 2);
    open(rowId(22));
    await until(() => held.length === 1, "the row refresh");
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${path}?view=needs_action"]`)!.click();
    await until(() => held.length === 2, "the view switch");
    held[1]!(200);
    await until(() => heading() === null && rows()[0] !== undefined, "the new view");
    held[0]!(200);
    await settle();
    expect(dom.document.body.textContent).not.toContain("Could not refresh this mailbox yet");
  });

  test("a reload of the shown view that ends after a conversation opened keeps that conversation and its URL", async () => {
    mount();
    let release = () => {};
    routeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${folderPath}"]`)!.click();
    await until(() => routeRequests.length === 1, "the held reload");
    open(rowId(10));
    await until(() => shows(rowId(10)), "the opened conversation");
    release();
    await settle();
    expect(shows(rowId(10))).toBe(true);
    expect(selected()).toBe(rowId(10));
  });

  test("an opening conversation shows the pending state, and a later navigation to the shown view wins", async () => {
    mount();
    let release = () => {};
    detailGate.set(
      rowId(10),
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const busy = () => dom.root.querySelector("[aria-busy]")?.getAttribute("aria-busy");
    expect(busy()).toBe("false");
    open(rowId(10));
    await until(() => busy() === "true", "the pending state");
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${folderPath}"]`)!.click();
    await until(() => routeRequests.length === 1, "the view reload");
    release();
    await until(() => busy() === "false", "the end of the pending state");
    await settle();
    expect(heading()).toBeNull();
    expect(selected()).toBeNull();
  });

  test("a live refresh after a detail open reloads page 1 with the open conversation", async () => {
    mount();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    open(rowId(10));
    await until(() => shows(rowId(10)), "the opened conversation");

    replies.set(rowId(10), "A fresh reply");
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: rowId(10) } });
    await until(() => dom.document.body.textContent?.includes("A fresh reply") === true, "the new message");
    expect(routeRequests).toEqual([`${folderPath}&conversation=${rowId(10)}`]);

    socket.message({ t: "event", id: "1", cursor: "s6t.mail.6", data: { conversationId: rowId(1) } });
    await until(() => routeRequests.length === 2, "the second refresh");
    await settle();
    expect(routeRequests[1]).toBe(`${folderPath}&conversation=${rowId(10)}`);
    expect(shows(rowId(10))).toBe(true);
    expect(selected()).toBe(rowId(10));
  });

  test("opening an unread conversation marks it read and updates the counts", async () => {
    unread = new Set([rowId(5), rowId(6)]);
    mount();
    expect(inboxLink()).toBe("Inbox2, 2 unread");
    open(rowId(5));
    await until(() => actionRequests.length === 1, "the mark read request");
    expect(actionRequests[0]!.conversationId).toBe(rowId(5));
    expect(actionRequests[0]!.body).toMatchObject({ kind: "change_state", change: { addFlags: ["seen"] }, sourceFolderId: FOLDER });
    await until(() => inboxLink() === "Inbox1, 1 unread", "the lowered unread count");
  });

  test("leaving the workspace cancels a conversation that is still loading", async () => {
    mount();
    detailGate.set(rowId(10), new Promise<void>(() => {}));
    open(rowId(10));
    await until(() => detailSignals.length === 1, "the held detail");
    expect(detailSignals[0]?.aborted).toBe(false);
    dispose();
    dispose = () => {};
    expect(detailSignals[0]?.aborted).toBe(true);
  });

  test("a message that arrived unread after the list loaded is marked read on open", async () => {
    mount();
    unread.add(rowId(12));
    open(rowId(12));
    await until(() => actionRequests.length === 1, "the mark read request");
    expect(actionRequests[0]!.conversationId).toBe(rowId(12));
    expect(actionRequests[0]!.body).toMatchObject({ kind: "change_state", change: { addFlags: ["seen"] }, sourceFolderId: FOLDER });
    // The row was older than the detail: page 1 reloaded it before auto mark-read decided.
    expect(routeRequests[0]).toBe(`${folderPath}&conversation=${rowId(12)}`);
  });

  test("a flag removed elsewhere after the list loaded refreshes the row", async () => {
    flagged.add(rowId(20));
    mount();
    flagged.delete(rowId(20));
    open(rowId(20));
    await until(() => shows(rowId(20)), "the opened conversation");
    await until(() => routeRequests.length === 1, "the list refresh");
    await until(() => dom.root.querySelector('[aria-label="Flagged conversation"]') === null, "the flag gone from the reader");
  });

  test("a flag removed elsewhere refreshes a row of a folderless list that lies in one folder", async () => {
    flagged.add(rowId(21));
    mount(`${path}?view=needs_action`);
    flagged.delete(rowId(21));
    open(rowId(21));
    await until(() => shows(rowId(21)), "the opened conversation");
    await until(() => routeRequests.length === 1, "the list refresh");
    expect(routeRequests).toEqual([`${path}?view=needs_action&conversation=${rowId(21)}`]);
  });

  test("tags a detail brought stay when another page is applied", async () => {
    mount();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: rowId(1) } });
    await until(() => routeRequests.length === 1, "the live refresh");
    await settle();
    mailboxTags = [{ id: "Tag001", mailboxId: MAILBOX_ID, name: "Urgent", color: "#ff0000", revision: 1, createdAt: now, updatedAt: now }];
    open(rowId(10));
    await until(() => shows(rowId(10)), "the opened conversation");
    await until(() => dom.document.body.textContent?.includes("Urgent") === true, "the new tag");
    await loadSecondPage();
    expect(dom.document.body.textContent).toContain("Urgent");
  });

  test("a message in another folder does not make the folder's row look older", async () => {
    // The conversation's second message lies unread and flagged in Archive only; the Inbox list states read and flag
    // for the Inbox only.
    elsewhere.add(rowId(17));
    mount();
    open(rowId(17));
    await until(() => shows(rowId(17)), "the opened conversation");
    await settle();
    expect(routeRequests).toEqual([]);
  });

  test("a row whose folder no longer holds any of its messages is refreshed", async () => {
    mount();
    // Moving a conversation on the server changes its placements, not its revision.
    moved.add(rowId(18));
    open(rowId(18));
    await until(() => shows(rowId(18)), "the opened conversation");
    await until(() => routeRequests.length === 1, "the list refresh");
    expect(routeRequests).toEqual([`${folderPath}&conversation=${rowId(18)}`]);
  });

  test("a search limited to a folder judges a row's unread state by that folder only", async () => {
    const search = encodeURIComponent(JSON.stringify({ expression: { type: "folder_id", folderId: FOLDER }, sort: "newest" }));
    // The search row is flagged, because search states flags for every folder; unread only for the Inbox.
    elsewhere.add(rowId(19));
    flagged.add(rowId(19));
    mount(`${path}?search=${search}`);
    open(rowId(19));
    await until(() => shows(rowId(19)), "the opened conversation");
    await settle();
    expect(detailRequests).toEqual([{ id: rowId(19), folder: FOLDER }]);
    expect(routeRequests).toEqual([]);
  });

  test("auto mark-read waits for the last of overlapping row refreshes", async () => {
    mount();
    const held: Array<(status: number) => void> = [];
    routeStatus = () => new Promise<number>((resolve) => held.push(resolve));
    unread.add(rowId(18));
    open(rowId(18));
    await until(() => held.length === 1, "the first row refresh");
    // B's message arrives after the first refresh read the list, so that refresh still shows B read.
    unread.add(rowId(19));
    open(rowId(19));
    await until(() => shows(rowId(19)), "the second conversation");
    held[0]!(200);
    await until(() => held.length === 2, "the second row refresh");
    await settle();
    expect(actionRequests).toEqual([]);
    held[1]!(200);
    await until(() => actionRequests.length === 1, "the mark read request");
    expect(actionRequests[0]!.conversationId).toBe(rowId(19));
    routeStatus = () => 200;
    for (const settleNext of held.slice(2)) settleNext(200);
  });

  test("a row older than its detail is refreshed with the list instead of taking the newer revision alone", async () => {
    mount();
    revisions.set(rowId(14), 2);
    open(rowId(14));
    await until(() => shows(rowId(14)), "the opened conversation");
    await until(() => routeRequests.length === 1, "the list refresh");
    expect(routeRequests).toEqual([`${folderPath}&conversation=${rowId(14)}`]);
    expect(shows(rowId(14))).toBe(true);
    // A row as new as its detail needs no refresh.
    open(rowId(15));
    await until(() => shows(rowId(15)), "the next conversation");
    await settle();
    expect(routeRequests).toHaveLength(1);
  });

  test("a flag set elsewhere after the list loaded refreshes the row, and the reader shows it", async () => {
    mount();
    flagged.add(rowId(16));
    open(rowId(16));
    await until(() => shows(rowId(16)), "the opened conversation");
    await until(() => routeRequests.length === 1, "the list refresh");
    expect(routeRequests).toEqual([`${folderPath}&conversation=${rowId(16)}`]);
    await until(() => dom.root.querySelector('[aria-label="Flagged conversation"]') !== null, "the flag in the reader");
  });

  test("Enter on a row focuses the reader heading", async () => {
    mount();
    open(rowId(7), "keyboard");
    await until(() => shows(rowId(7)), "the opened conversation");
    expect(dom.document.activeElement).toBe(dom.root.querySelector("[data-mail-reader-heading]"));
    expect(routeRequests).toEqual([]);
  });

  test("a conversation that is gone opens the list without it, as a fresh load of that URL does", async () => {
    mount();
    detailStatus = () => 404;
    open(rowId(8));
    await until(() => routeRequests.length === 1, "the workspace reload");
    expect(routeRequests).toEqual([`${folderPath}&conversation=${rowId(8)}`]);
  });

  test("a failed open says so and keeps the open conversation", async () => {
    mount();
    open(A);
    await until(() => shows(A), "conversation A");
    detailStatus = () => 503;
    open(rowId(9));
    await until(() => dom.document.body.textContent?.includes("Could not open this conversation") === true, "the failure notice");
    expect(shows(A)).toBe(true);
    expect(selected()).toBe(A);
    expect(routeRequests).toEqual([]);
  });
});
