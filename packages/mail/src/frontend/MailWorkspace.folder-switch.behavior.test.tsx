import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { resolveMailSearchRoute } from "../search-state";
import type { MailboxListView, MailboxPageData } from "../service/workspace";
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
    mailTestFolder("Filed1", { role: "custom", providerRole: "custom", name: "Filed" }),
    mailTestFolder("Drafts1", { role: "drafts", providerRole: "drafts", name: "Drafts", unread: 0 }),
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
  listItems: [mailTestRow("one"), mailTestRow("two"), mailTestRow("three")],
  listCursor: null,
  nextListCursor: null,
  listError: null,
  listTitle: "Needs action",
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
  disconnect(code: number) {
    this.close();
    this.onclose?.({ code, reason: "test close" });
  }
}

const path = `/app/mail/${MAILBOX_ID}`;
/** Long enough for a refresh through the mocked API to finish. */
const settle = () => Bun.sleep(60);

type RecordedRequest = { route: "workspace-route" | "workspace-list"; href: string; bytes: number };

describe("Mail workspace folder switches", () => {
  if (isServer) {
    test.skip("runs in the browser-conditions process", () => {});
    return;
  }
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  let dom: DomTestHarness;
  let dispose = () => {};
  let requests: RecordedRequest[];
  let truth: Pick<MailboxPageData, "mailbox" | "permission" | "access" | "savedViews"> & {
    unread: number;
    total: number;
    needsAction: number;
    scheduled: number;
  };
  let failure: number | null;

  const listFor = (href: string, listMode: MailboxListView["listMode"] = "conversations"): MailboxListView => {
    const url = new URL(href, "http://localhost");
    const params = url.searchParams;
    const folderId = params.get("folder");
    const savedViewId = params.get("savedView");
    const search = resolveMailSearchRoute(url);
    const searching = params.has("q") || params.has("searchFrom");
    const draftsMode = folderId === "Drafts1";
    const scheduledMode = params.has("scheduled");
    const activeView = params.get("view") === "waiting" ? "waiting" : null;
    const title = searching
      ? "Search results"
      : draftsMode
        ? "Drafts"
        : scheduledMode
          ? "Scheduled"
          : savedViewId
            ? (truth.savedViews.find((view) => view.id === savedViewId)?.name ?? "All mail")
            : activeView
              ? "Waiting"
              : folderId === "Filed1"
                ? "Filed"
                : "All mail";
    return {
      mailbox: truth.mailbox,
      permission: truth.permission,
      access: truth.access,
      savedViews: truth.savedViews,
      scheduledMode,
      scheduledPage: scheduledMode
        ? {
            items: [
              {
                id: "Send1",
                commandId: "00000000-0000-4000-8000-000000000002",
                draftId: "Draft1",
                conversationId: null,
                intent: "new",
                to: [],
                cc: [],
                bcc: [],
                subject: "Scheduled offer",
                bodyPreview: "Preview",
                scheduledAt: now,
                nextAttemptAt: null,
                state: "scheduled",
                attempt: 0,
                lastErrorCode: null,
                lastError: null,
                scheduledBy: { kind: "user", displayName: "Ada" },
                createdAt: now,
              },
            ],
            nextCursor: null,
            total: 6,
          }
        : null,
      scheduledError: null,
      draftsMode,
      draftsPage: draftsMode
        ? {
            items: [
              {
                id: "Draft1",
                conversationId: null,
                intent: "new",
                subject: "Draft offer",
                to: [],
                cc: [],
                bcc: [],
                bodyPreview: "Preview",
                createdByDisplayName: "Ada",
                updatedAt: now,
              },
            ],
            nextCursor: null,
            total: 1,
          }
        : null,
      draftsError: null,
      activeView,
      savedViewId,
      listMode,
      folderId,
      query: search.query,
      search,
      listItems: draftsMode || scheduledMode ? [] : [mailTestRow(title, { unread: false, unreadFolderIds: [] })],
      listCursor: null,
      nextListCursor: null,
      listError: null,
      listTitle: title,
    };
  };
  const snapshotFor = (href: string, listMode?: MailboxListView["listMode"]): MailboxPageData => {
    const list = listFor(href, listMode);
    return {
      ...structuredClone(data),
      ...list,
      folders: data.folders.map((folder) => (folder.id === "Filed1" ? { ...folder, unread: truth.unread, total: truth.total } : folder)),
      viewCounts: { ...data.viewCounts, needs_action: truth.needsAction },
      scheduledCount: list.scheduledPage?.total ?? truth.scheduled,
      selectedConversationId: new URL(href, "http://localhost").searchParams.get("conversation"),
    };
  };
  beforeEach(() => {
    setSystemTime(new Date(now));
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "CSS", { value: dom.window.CSS, configurable: true });
    FakeWebSocket.instances = [];
    Reflect.set(globalThis, "WebSocket", FakeWebSocket);
    requests = [];
    truth = {
      mailbox: structuredClone(data.mailbox),
      permission: data.permission,
      access: structuredClone(data.access),
      savedViews: structuredClone(data.savedViews),
      unread: 3,
      total: 3,
      needsAction: 3,
      scheduled: 2,
    };
    failure = null;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        const href = url.searchParams.get("href") ?? "";
        const route = url.pathname.endsWith("/workspace-route")
          ? "workspace-route"
          : url.pathname.endsWith("/workspace-list")
            ? "workspace-list"
            : null;
        if (route) {
          const listMode = url.searchParams.get("listMode") === "messages" ? "messages" : "conversations";
          const body = JSON.stringify(
            route === "workspace-list" && failure
              ? { error: "denied" }
              : route === "workspace-list"
                ? listFor(href, listMode)
                : snapshotFor(href, listMode),
          );
          requests.push({ route, href, bytes: new TextEncoder().encode(body).byteLength });
          return new Response(body, {
            status: route === "workspace-list" ? (failure ?? 200) : 200,
            headers: { "content-type": "application/json" },
          });
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
  const mount = (initialLiveCursor: string | null = data.initialLiveCursor) => {
    dom.window.history.replaceState(null, "", path);
    const m = modules!;
    dispose = render(
      () =>
        createComponent(m.MailWorkspace, {
          data: { ...snapshotFor(path), initialLiveCursor },
          requestPath: path,
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
  const caughtUp = async () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: data.initialLiveCursor });
    await settle();
    return socket;
  };
  const link = (href: string) => dom.root.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!;
  const heading = () => dom.root.querySelector("[data-mail-list-heading]")?.textContent;
  const rowIds = () =>
    [...dom.root.querySelectorAll<HTMLElement>("[data-mail-conversation-list] [data-conversation-id]")].map(
      (row) => row.dataset.conversationId,
    );
  const location = () => `${window.location.pathname}${window.location.search}`;
  // A custom folder, because the Inbox badge keeps its first count after any refresh (#1481).
  const counts = (unread = 3, needsAction = 3) => {
    expect(link(`${path}?view=needs_action`).textContent).toBe(`Needs action${needsAction}`);
    expect(link(`${path}?folder=Filed1`).textContent).toBe(`Filed${unread}, ${unread} unread`);
  };
  const expectRequests = (route: RecordedRequest["route"], href: string) => {
    expect(requests.map(({ route, href }) => ({ route, href }))).toEqual([{ route, href }]);
    expect(requests.every((request) => request.bytes > 0)).toBe(true);
  };
  const assertList = (href: string, title: string) => {
    expectRequests("workspace-list", href);
    expect(heading()).toBe(title);
    expect(rowIds()).toEqual([title]);
    expect(location()).toBe(href);
  };
  const switchTo = async (query: string) => {
    requests = [];
    link(`${path}?${query}`).click();
    await settle();
  };

  test("caught-up folder, view, saved view, Drafts, Scheduled and search switches keep the mailbox frame", async () => {
    mount();
    await caughtUp();
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Select conversations"]')!.click();
    expect(dom.root.querySelector('.mail-list-entry input[type="checkbox"]')).not.toBeNull();
    truth = { ...truth, unread: 7, total: 12, needsAction: 9, scheduled: 4 };
    await switchTo("folder=Filed1");
    assertList(`${path}?folder=Filed1`, "Filed");
    counts();
    expect(dom.root.querySelector('.mail-list-entry input[type="checkbox"]')).toBeNull();
    for (const [query, title] of [
      ["view=waiting", "Waiting"],
      ["savedView=Saved1", "Priority"],
    ]) {
      await switchTo(query!);
      assertList(`${path}?${query}`, title!);
      counts();
    }
    expect(link(`${path}?savedView=Saved1`).getAttribute("aria-current")).toBe("page");
    await switchTo("folder=Drafts1");
    expectRequests("workspace-list", `${path}?folder=Drafts1`);
    expect(dom.root.textContent).toContain("Draft offer");
    expect(dom.root.querySelector("h1")?.textContent).toBe("Drafts");
    expect(location()).toBe(`${path}?folder=Drafts1`);
    counts();
    await switchTo("scheduled=1");
    expectRequests("workspace-list", `${path}?scheduled=1`);
    expect(dom.root.textContent).toContain("Scheduled offer");
    expect(dom.root.querySelector("h1")?.textContent).toBe("Scheduled");
    expect(link(`${path}?scheduled=1`).textContent).toBe("Scheduled6");
    expect(location()).toBe(`${path}?scheduled=1`);
    counts();
    await switchTo("folder=Filed1");
    assertList(`${path}?folder=Filed1`, "Filed");
    requests = [];
    const input = dom.root.querySelector<HTMLInputElement>('input[name="q"]')!;
    input.value = "invoice";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    // The real search control submits after its 300 ms debounce.
    await Bun.sleep(380);
    assertList(`${path}?searchFrom=folder%3DFiled1&q=invoice`, "Search results");
    counts();
    requests = [];
    dom.root.querySelector<HTMLButtonElement>('form[role="search"] button[aria-label="Clear"]')!.click();
    await settle();
    assertList(`${path}?folder=Filed1`, "Filed");
    counts();
  });

  test("a caught-up folder switch takes mailbox and saved view names from the list and keeps counts", async () => {
    mount();
    await caughtUp();
    truth = {
      ...truth,
      mailbox: { ...truth.mailbox, name: "Renamed support" },
      savedViews: truth.savedViews.map((view) => ({ ...view, name: "Renamed priority" })),
      unread: 7,
      total: 12,
      needsAction: 9,
    };
    await switchTo("folder=Filed1");
    assertList(`${path}?folder=Filed1`, "Filed");
    const sidebar = link(`${path}?savedView=Saved1`).closest("aside")!;
    expect(sidebar.textContent).toContain("Renamed support");
    expect(link(`${path}?savedView=Saved1`).textContent).toBe("Renamed priority");
    counts();
  });

  test("a live event after a list switch reloads the frame's folder and view counts", async () => {
    mount();
    const socket = await caughtUp();
    truth = { ...truth, unread: 7, total: 12, needsAction: 9, scheduled: 4 };
    await switchTo("folder=Filed1");
    assertList(`${path}?folder=Filed1`, "Filed");
    counts();
    requests = [];
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: null } });
    await settle();
    expectRequests("workspace-route", `${path}?folder=Filed1`);
    counts(7, 9);
  });

  test("a live event while the list loads reloads the snapshot after it", async () => {
    mount();
    const socket = await caughtUp();
    truth = { ...truth, unread: 7, total: 12, needsAction: 9, scheduled: 4 };
    const fetchMock = globalThis.fetch;
    let releaseList = () => {};
    const listHeld = new Promise<void>((resolve) => (releaseList = resolve));
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        if (url.pathname.endsWith("/workspace-list")) await listHeld;
        return fetchMock(input, init);
      },
      { preconnect: originalFetch.preconnect },
    );
    requests = [];
    link(`${path}?folder=Filed1`).click();
    await Bun.sleep(0);
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: null } });
    await settle();
    releaseList();
    await settle();
    expect(requests.map(({ route, href }) => ({ route, href }))).toEqual([
      { route: "workspace-list", href: `${path}?folder=Filed1` },
      { route: "workspace-route", href: `${path}?folder=Filed1` },
    ]);
    expect(heading()).toBe("Filed");
    expect(location()).toBe(`${path}?folder=Filed1`);
    counts(7, 9);
  });

  for (const state of ["unconfirmed", "disconnected", "unavailable"] as const)
    test(`${state} live updates load the full snapshot on a folder switch`, async () => {
      mount();
      if (state === "unconfirmed") FakeWebSocket.instances.at(-1)!.open();
      else {
        const socket = await caughtUp();
        if (state === "unavailable") window.sessionStorage.setItem(`cloud.reload.mail:live:${MAILBOX_ID}`, String(new Date(now).getTime()));
        socket.disconnect(state === "unavailable" ? 1008 : 1006);
        await settle();
      }
      await switchTo("folder=Filed1");
      expectRequests("workspace-route", `${path}?folder=Filed1`);
      expect(heading()).toBe("Filed");
      counts();
      if (state === "unavailable") expect(dom.root.textContent).toContain("Updates paused");
    });

  test("a page that started without a live cursor loads the full snapshot on a folder switch", async () => {
    // The subscription then starts at the current position, so changes between the page and the subscription never arrive.
    mount(null);
    await caughtUp();
    await switchTo("folder=Filed1");
    expectRequests("workspace-route", `${path}?folder=Filed1`);
    expect(heading()).toBe("Filed");
  });

  test("Back after two list switches loads the previous scope and then the start through workspace-list", async () => {
    mount();
    await caughtUp();
    await switchTo("folder=Filed1");
    assertList(`${path}?folder=Filed1`, "Filed");
    await switchTo("savedView=Saved1");
    assertList(`${path}?savedView=Saved1`, "Priority");
    requests = [];
    dom.window.history.back();
    await settle();
    assertList(`${path}?folder=Filed1`, "Filed");
    requests = [];
    dom.window.history.back();
    await settle();
    assertList(path, "All mail");
  });

  for (const status of [403, 404])
    test(`a ${status} list switch keeps the committed view and reports the failure`, async () => {
      mount();
      await caughtUp();
      failure = status;
      await switchTo("folder=Filed1");
      expect(requests.map(({ route, href }) => ({ route, href }))).toEqual([
        { route: "workspace-list", href: `${path}?folder=Filed1` },
        // Resetting the failed source reloads the committed scope through the snapshot path.
        { route: "workspace-route", href: path },
      ]);
      expect(heading()).toBe("All mail");
      expect(rowIds()).toEqual(["All mail"]);
      counts();
      expect(location()).toBe(path);
      expect(dom.document.body.textContent).toContain("Could not open this mailbox view. Your current view was kept.");
    });

  test("a target with a conversation selection keeps the snapshot path", async () => {
    mount();
    await caughtUp();
    dom.window.history.pushState(null, "", `${path}?folder=Filed1&conversation=other`);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await settle();
    expectRequests("workspace-route", `${path}?folder=Filed1&conversation=other`);
  });

  test("changing the list mode through its control keeps the snapshot path", async () => {
    mount();
    await caughtUp();
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Choose list view"]')!.click();
    await Bun.sleep(0);
    const item = [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Message view",
    )!;
    item.click();
    await settle();
    expectRequests("workspace-route", path);
  });
});
