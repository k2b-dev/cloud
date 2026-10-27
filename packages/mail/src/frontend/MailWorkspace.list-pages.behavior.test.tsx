import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { resolveMailSearchRoute } from "../search-state";
import type { MailboxListView, MailboxPageData, MailListItem } from "../service/workspace";
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
const now = "2026-10-03T10:00:00.000Z";

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
    composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
    createdAt: now,
    updatedAt: now,
  },
  permission: "write",
  access: { scope: "mailbox", permission: "write" },
  initialLiveCursor: "s6t.mail.4",
  folders: [
    mailTestFolder("Inbox1", { role: "inbox", providerRole: "inbox", name: "Inbox" }),
    mailTestFolder("Trash1", { role: "trash", providerRole: "trash", name: "Trash", unread: 0 }),
  ],
  identities: [],
  scheduledMode: false,
  scheduledCount: 0,
  scheduledPage: null,
  scheduledError: null,
  draftsMode: false,
  draftsPage: null,
  draftsError: null,
  activeView: null,
  savedViewId: null,
  savedViews: [],
  listMode: "conversations",
  folderId: null,
  viewCounts: { needs_action: 3, mine: 0, unassigned: 0, waiting: 0, done: 0, snoozed: 0, send_problems: 0, recently_active: 0, kept: 0 },
  query: "",
  search: { query: "", expression: null, sort: "relevance", error: null },
  selectedConversationId: null,
  selectedMessageId: null,
  listItems: [mailTestRow("one"), mailTestRow("two"), mailTestRow("three")],
  listCursor: null,
  nextListCursor: null,
  listError: null,
  listTitle: "Needs action",
  conversationRowState: null,
  detailMessages: [],
  conversationSummary: null,
  conversationDrafts: [],
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

const readerMessage: MailboxPageData["detailMessages"][number] = {
  id: "Msg001",
  subject: "one",
  messageId: "<one@example.test>",
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
  folderId: "Inbox1",
  deletedOnServer: false,
  contentType: "text/plain",
  sizeBytes: 64,
  plainText: "Hello",
  sanitizedHtml: null,
  forwardText: "",
  selectedHeaders: {},
  sourceAvailable: true,
  mailingList: null,
  remoteContent: { imageIds: [], allowedByRule: false, sender: "sender@example.test", domain: "example.test" },
  delivery: null,
  attachments: [],
};

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

const path = `/app/mail/${MAILBOX_ID}`;
/** Long enough for a refresh through the mocked API to finish. */
const settle = () => Bun.sleep(60);

/** Needs action pages through three cursor pages; a search has one page of its own. */
const PAGES: Record<string, { rows: string[]; next: string | null }> = {
  first: { rows: ["one", "two", "three"], next: "c2" },
  c2: { rows: ["four", "five"], next: "c3" },
  c3: { rows: ["six"], next: null },
};
const allRows = ["one", "two", "three", "four", "five", "six"];

describe("Mail workspace list pages", () => {
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
  /** Rows that arrived after the page loaded; they lead page 1 and raise its counts. */
  let arrived: string[];

  const listFor = (href: string): MailboxListView => {
    const url = new URL(href, "http://localhost");
    const params = url.searchParams;
    const searching = params.has("searchFrom") || params.has("q");
    const cursor = params.get("cursor");
    const page = searching ? { rows: ["hit"], next: null } : PAGES[cursor ?? "first"]!;
    const rows = [...(!searching && !cursor ? arrived : []), ...page.rows];
    return {
      mailbox: data.mailbox,
      permission: data.permission,
      access: data.access,
      savedViews: data.savedViews,
      scheduledMode: false,
      scheduledPage: null,
      scheduledError: null,
      draftsMode: false,
      draftsPage: null,
      draftsError: null,
      activeView: searching ? null : "needs_action",
      savedViewId: null,
      listMode: "conversations",
      folderId: null,
      query: resolveMailSearchRoute(url).query,
      search: resolveMailSearchRoute(url),
      // Read rows, so opening one does not mark it read and refresh the view on its own.
      listItems: rows.map((id): MailListItem => mailTestRow(id, { unread: false, unreadFolderIds: [] })),
      listCursor: cursor,
      nextListCursor: page.next,
      listError: null,
      listTitle: searching ? "Search results" : "Needs action",
    };
  };
  const snapshotFor = (href: string): MailboxPageData => {
    const conversation = new URL(href, "http://localhost").searchParams.get("conversation");
    const unread = 3 + arrived.length;
    return {
      ...structuredClone(data),
      ...listFor(href),
      folders: [
        mailTestFolder("inbox", { role: "inbox", providerRole: "inbox", name: "Inbox", unread, total: unread }),
        mailTestFolder("Trash1", { role: "trash", providerRole: "trash", name: "Trash", unread: 0 }),
      ],
      viewCounts: { ...data.viewCounts, needs_action: unread },
      selectedConversationId: conversation,
      selectedSubject: conversation ? "one" : "",
      detailMessages: conversation ? [readerMessage] : [],
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
    arrived = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        const href = url.searchParams.get("href") ?? "";
        if (url.pathname.endsWith("/workspace-route")) {
          routeRequests.push(href);
          return Response.json(snapshotFor(href));
        }
        if (url.pathname.endsWith("/workspace-list")) {
          listRequests.push(href);
          return Response.json(listFor(href));
        }
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
  const mount = (query: string) => {
    const href = `${path}?${query}`;
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
          sidebar: {
            mailboxes: [{ ...data.mailbox, receivingAddress: data.receivingAddress }],
            pinnedMailboxIds: [],
            hiddenMailboxIds: [],
          },
        }),
      dom.root,
    );
  };
  const loadPage = async (cursor: string) => {
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${path}?view=needs_action&cursor=${cursor}"]`)!.click();
    await settle();
  };
  const rowIds = () =>
    [...dom.root.querySelectorAll<HTMLElement>("[data-mail-conversation-list] [data-conversation-id]")].map(
      (row) => row.dataset.conversationId,
    );
  const needsActionLink = () =>
    [...dom.root.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.getAttribute("href") === `${path}?view=needs_action`)
      ?.textContent;
  const listPages = (...cursors: string[]) => cursors.map((cursor) => `${path}?view=needs_action&cursor=${cursor}`);
  const scroller = () => dom.root.querySelector<HTMLElement>(`[data-scroll-preserve="mail-list-${MAILBOX_ID}"]`)!;

  test("pages from 2 on load only their list page, and a live refresh rebuilds only page 1", async () => {
    mount("view=needs_action&conversation=one");
    await loadPage("c2");
    await loadPage("c3");
    expect(routeRequests).toEqual([]);
    // The list does not depend on the open conversation, so its requests do not name it.
    expect(listRequests).toEqual(listPages("c2", "c3"));
    expect(rowIds()).toEqual(allRows);
    expect(needsActionLink()).toBe("Needs action3");

    arrived = ["new"];
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    await settle();
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: "new" } });
    await settle();
    // Page 1 still brings the folders, counts and the open conversation; the loaded pages after it are list pages.
    expect(routeRequests).toEqual([`${path}?view=needs_action&conversation=one`]);
    expect(listRequests).toEqual(listPages("c2", "c3", "c2", "c3"));
    expect(rowIds()).toEqual(["new", ...allRows]);
    expect(needsActionLink()).toBe("Needs action4");
    expect(dom.root.querySelector("[data-mail-reader-heading]")?.textContent).toBe("one");
  });

  test("a failed list page keeps the loaded rows and says so", async () => {
    mount("view=needs_action");
    const fetchList = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        if (url.pathname.endsWith("/workspace-list")) return Response.json({ error: "unavailable" }, { status: 503 });
        return fetchList(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    await loadPage("c2");
    expect(rowIds()).toEqual(["one", "two", "three"]);
    expect(dom.document.body.textContent).toContain("Could not load mailbox view");
    expect(dom.root.querySelector(`a[href="${path}?view=needs_action&cursor=c2"]`)).not.toBeNull();
  });

  test("clearing a search started on page 3 restores the three pages through one snapshot and two list pages", async () => {
    mount("view=needs_action");
    await loadPage("c2");
    await loadPage("c3");
    scroller().scrollTop = 480;
    dom.root.querySelector<HTMLButtonElement>("[data-mail-search-trigger]")?.click();
    const input = dom.root.querySelector<HTMLInputElement>('input[name="q"]')!;
    input.value = "invoice";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Bun.sleep(380);
    expect(rowIds()).toEqual(["hit"]);
    routeRequests = [];
    listRequests = [];
    scroller().scrollTop = 20;
    dom.root.querySelector<HTMLButtonElement>('form[role="search"] button[aria-label="Clear"]')!.click();
    await settle();
    expect(routeRequests).toEqual([`${path}?view=needs_action`]);
    expect(listRequests).toEqual(listPages("c2", "c3"));
    expect(rowIds()).toEqual(allRows);
    expect(scroller().scrollTop).toBe(480);
  });
});
