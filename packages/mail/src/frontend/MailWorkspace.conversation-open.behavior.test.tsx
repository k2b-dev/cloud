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
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
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
  let actionRequests: { conversationId: string; body: unknown }[];
  /** Conversations still unread on the server. */
  let unread: Set<string>;
  /** Extra messages that arrived in a conversation after the page loaded. */
  let replies: Map<string, string>;
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
      activeView: null,
      savedViewId: null,
      listMode: "conversations",
      folderId: FOLDER,
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
      localTags: [],
      selectedSubject: `Subject ${conversationId}`,
      detailMessages: [
        {
          ...message(`m-${conversationId}`, `Subject ${conversationId}`, `Body of ${conversationId}`),
          flags: unread.has(conversationId) ? [] : ["\\Seen"],
        },
        ...(reply ? [message(`r-${conversationId}`, `Subject ${conversationId}`, reply)] : []),
      ],
      conversationSummary: null,
      conversationDrafts: [],
      detailError: null,
      collaborationState: null,
      conversationLocalTags: null,
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
    actionRequests = [];
    unread = new Set();
    replies = new Map();
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
    expect(routeRequests).toHaveLength(1);
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
