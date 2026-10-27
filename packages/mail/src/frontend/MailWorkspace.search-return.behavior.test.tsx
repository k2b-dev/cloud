import { afterEach, beforeEach, describe, expect, jest, mock, setSystemTime, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { resolveMailSearchRoute } from "../search-state";
import { mailTagSearch } from "../search-url";
import type { MailboxPageData } from "../service/workspace";
import type { MailSearchBuilderResult } from "./_components/MailSearchBuilder";
import { mailTestFolder, mailTestRow } from "./_components/mail-list-test-fixtures";

let builderResult: MailSearchBuilderResult | undefined;
mock.module("./_components/MailSearchBuilder", () => ({ openMailSearchBuilder: async () => builderResult }));

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
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send() {}
  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const path = `/app/mail/${MAILBOX_ID}`;
const tag = mailTagSearch("Tag001");
if (!tag.ok) throw new Error("Invalid tag fixture");
const tagQuery = new URLSearchParams({ search: tag.value }).toString();
const settle = () => Bun.sleep(50);

describe("Mail workspace search return", () => {
  if (isServer) {
    test.skip("runs in the browser-conditions process", () => {});
    return;
  }
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  let dom: DomTestHarness;
  let dispose = () => {};
  let workspaceRequests: string[];
  /** Pages from 2 on load only their list page. */
  let listRequests: string[];
  let emptyResults: boolean;
  let invalidSearch: boolean;
  let heldSearchResponse: Promise<Response> | undefined;
  let heldCursorResponse: Promise<Response> | undefined;
  let heldNavigationResponse: Promise<Response> | undefined;

  const snapshotFor = (href: string): MailboxPageData => {
    const url = new URL(href, "http://localhost");
    const params = url.searchParams;
    const searching = params.has("searchFrom") || params.has("q");
    const activeView =
      !searching && params.get("view") === "needs_action" ? "needs_action" : !searching && params.get("view") === "done" ? "done" : null;
    const conversation = params.get("conversation");
    const search = resolveMailSearchRoute(url);
    return {
      ...structuredClone(data),
      activeView,
      folderId: params.get("folder"),
      savedViewId: params.get("savedView"),
      scheduledMode: params.has("scheduled"),
      scheduledPage: params.has("scheduled") ? { items: [], nextCursor: null, total: 0 } : null,
      listTitle: searching
        ? "Search results"
        : activeView === "needs_action"
          ? "Needs action"
          : activeView === "done"
            ? "Done"
            : params.has("folder")
              ? "Inbox"
              : params.has("savedView")
                ? "Saved view"
                : params.has("search")
                  ? "Tagged mail"
                  : "All mail",
      query: search.query,
      search,
      listItems:
        searching && emptyResults
          ? []
          : activeView === "needs_action" && params.has("cursor")
            ? [mailTestRow("page-two")]
            : data.listItems.map((item) => ({ ...item, unread: false })),
      nextListCursor: activeView === "needs_action" && !params.has("cursor") ? "needs-action-next" : null,
      listError: searching && invalidSearch ? "invalid_search" : null,
      selectedConversationId: conversation,
      selectedMessageId: params.get("message"),
      selectedSubject: conversation ? "one" : "",
      detailMessages: conversation ? [readerMessage] : [],
    };
  };

  beforeEach(() => {
    setSystemTime(new Date(now));
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "CSS", { value: dom.window.CSS, configurable: true });
    Reflect.set(globalThis, "WebSocket", FakeWebSocket);
    workspaceRequests = [];
    listRequests = [];
    emptyResults = false;
    invalidSearch = false;
    heldSearchResponse = undefined;
    heldCursorResponse = undefined;
    heldNavigationResponse = undefined;
    builderResult = undefined;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        if (url.pathname.endsWith("/workspace-route")) {
          const href = url.searchParams.get("href") ?? "";
          workspaceRequests.push(href);
          if (new URL(href, "http://localhost").searchParams.has("q") && heldSearchResponse) return heldSearchResponse;
          if (!new URL(href, "http://localhost").searchParams.has("q") && heldNavigationResponse) return heldNavigationResponse;
          return Response.json(snapshotFor(href));
        }
        if (url.pathname.endsWith("/workspace-list")) {
          const href = url.searchParams.get("href") ?? "";
          listRequests.push(href);
          if (heldCursorResponse) return heldCursorResponse;
          return Response.json(snapshotFor(href));
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
    if (jest.isFakeTimers()) jest.clearAllTimers();
    jest.useRealTimers();
    await Bun.sleep(20);
    globalThis.fetch = originalFetch;
    Reflect.set(globalThis, "WebSocket", originalWebSocket);
    dom.cleanup();
    if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
    else Reflect.deleteProperty(globalThis, "CSS");
    setSystemTime();
  });
  const mount = (query = "view=needs_action") => {
    const href = `${path}${query ? `?${query}` : ""}`;
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
  const input = () => dom.root.querySelector<HTMLInputElement>('input[name="q"]')!;
  const type = (value: string) => {
    if (!input()) dom.root.querySelector<HTMLButtonElement>("[data-mail-search-trigger]")!.click();
    input().value = value;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };
  const search = async () => {
    const start = location.search.slice(1);
    type("invoice");
    await Bun.sleep(380);
    expect(new URL(location.href).searchParams.get("searchFrom")).toBe(start);
    expect(title()).toBe("Search results");
  };
  const clearButton = () => dom.root.querySelector<HTMLButtonElement>('form[role="search"] button[aria-label="Clear"]')!;
  const title = () => dom.root.querySelector("[data-mail-list-heading]")?.textContent;
  const assertRoute = (query: string, expectedTitle: string) => {
    const expected = `${path}${query ? `?${query}` : ""}`;
    expect(location.pathname + location.search).toBe(expected);
    const last = new URL(workspaceRequests.at(-1)!, "http://localhost");
    expect(last.pathname + last.search).toBe(expected);
    expect(title()).toBe(expectedTitle);
  };
  const clickLink = async (query: string) => {
    const href = `${path}${query ? `?${query}` : ""}`;
    if (!dom.root.querySelector(`a[href="${href}"]`)) dom.root.querySelector<HTMLButtonElement>('button[aria-label="More views"]')!.click();
    dom.document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!.click();
    await settle();
  };
  const scroller = () => dom.root.querySelector<HTMLElement>('[data-scroll-preserve="mail-list-Box001"]')!;
  const loadSecondPage = async () => {
    dom.root.querySelector<HTMLAnchorElement>(`a[href="${path}?view=needs_action&cursor=needs-action-next"]`)!.click();
    await settle();
    expect(dom.root.querySelector('[data-conversation-id="page-two"]')).not.toBeNull();
  };

  for (const action of ["Reset", "sidebar folder"]) {
    test(`${action} cancels a pending quick search before a slow navigation`, async () => {
      jest.useFakeTimers();
      setSystemTime(new Date(now));
      mount("q=old");
      const response = Promise.withResolvers<Response>();
      heldNavigationResponse = response.promise;
      const target = action === "Reset" ? path : `${path}?folder=Inbox1`;
      const head = dom.root.querySelector(".k2b-app-workspace__head")!;
      type("new");
      jest.advanceTimersByTime(100);
      if (action === "Reset") {
        [...head.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Reset")!.click();
      } else {
        dom.root.querySelector<HTMLAnchorElement>(`a[href="${target}"]`)!.click();
      }
      const flush = async () => {
        for (let turn = 0; turn < 40; turn++) await Promise.resolve();
      };
      await flush();
      expect(workspaceRequests).toEqual([target]);
      jest.advanceTimersByTime(300);
      await flush();
      response.resolve(Response.json(snapshotFor(target)));
      await flush();
      expect(location.pathname + location.search).toBe(target);
      expect(workspaceRequests).toEqual([target]);
      expect(new URL(location.href).searchParams.has("q")).toBe(false);
      expect(input()?.value ?? "").toBe("");
      expect(title()).toBe(action === "Reset" ? "All mail" : "Inbox");
    });
  }

  for (const method of ["delete", "Escape", "button"]) {
    test(`clearing a pending first quick search via ${method} supersedes its response`, async () => {
      mount("view=needs_action&conversation=one");
      const response = Promise.withResolvers<Response>();
      heldSearchResponse = response.promise;
      type("invoice");
      await Bun.sleep(380);
      expect(workspaceRequests).toHaveLength(1);
      expect(new URL(workspaceRequests[0]!, "http://localhost").searchParams.get("q")).toBe("invoice");
      const historyLength = history.length;
      if (method === "button") clearButton().click();
      else if (method === "delete") type("");
      else input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await settle();
      response.resolve(Response.json(snapshotFor(workspaceRequests[0]!)));
      await settle();
      assertRoute("view=needs_action&conversation=one", "Needs action");
      expect(input()?.value ?? "").toBe("");
      expect(history.length).toBe(historyLength);
      expect(dom.root.querySelector("[data-mail-reader-heading]")?.textContent).toBe("one");
    });
  }

  for (const method of ["button", "Escape"]) {
    test(`a tag view stays put when cleared via ${method} before the debounce`, async () => {
      mount(tagQuery);
      type("i");
      if (method === "button") clearButton().click();
      else input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await Bun.sleep(380);
      expect(location.pathname + location.search).toBe(`${path}?${tagQuery}`);
      expect(workspaceRequests).toEqual([]);
      expect(input()?.value ?? "").toBe("");
      expect(title()).toBe("Tagged mail");
    });
  }

  for (const method of ["button", "delete", "Escape"]) {
    test(`quick search returns to Needs action and its open conversation via ${method}`, async () => {
      mount("view=needs_action&conversation=one");
      await search();
      if (method === "button") clearButton().click();
      else if (method === "delete") type("");
      else input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await settle();
      assertRoute("view=needs_action&conversation=one", "Needs action");
      expect(input()?.value ?? "").toBe("");
      expect(dom.root.querySelector("[data-mail-reader-heading]")?.textContent).toBe("one");
    });
  }

  for (const [origin, expectedTitle] of [
    ["folder=Inbox1", "Inbox"],
    ["savedView=Saved1", "Saved view"],
    [tagQuery, "Tagged mail"],
    ["", "All mail"],
  ]) {
    test(`quick search returns to ${expectedTitle}`, async () => {
      mount(origin);
      await search();
      clearButton().click();
      await settle();
      assertRoute(origin!, expectedTitle!);
    });
  }

  test("clearing a reloaded search returns to Scheduled", async () => {
    mount("searchFrom=scheduled%3D1&q=invoice");
    clearButton().click();
    await settle();
    expect(location.pathname + location.search).toBe(`${path}?scheduled=1`);
    const last = new URL(workspaceRequests.at(-1)!, "http://localhost");
    expect(last.pathname + last.search).toBe(`${path}?scheduled=1`);
    expect(dom.root.querySelector("[data-mail-conversation-list]")).toBeNull();
    expect(dom.root.querySelector("section > h1")?.textContent).toBe("Scheduled");
  });

  test("structured search records Needs action and builder clear restores it", async () => {
    mount("view=needs_action&conversation=one");
    const state = {
      expression: { type: "text" as const, field: "any" as const, query: "invoice", match: "words" as const },
      sort: "newest" as const,
    };
    builderResult = { action: "apply", state, serialized: JSON.stringify(state) };
    if (!input()) dom.root.querySelector<HTMLButtonElement>("[data-mail-search-trigger]")!.click();
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Search filters"]')!.click();
    await settle();
    expect(new URL(location.href).searchParams.get("searchFrom")).toBe("view=needs_action&conversation=one");
    expect(title()).toBe("Search results");
    builderResult = { action: "clear" };
    if (!input()) dom.root.querySelector<HTMLButtonElement>("[data-mail-search-trigger]")!.click();
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Search filters"]')!.click();
    await settle();
    assertRoute("view=needs_action&conversation=one", "Needs action");
  });

  for (const invalid of [false, true]) {
    test(`${invalid ? "invalid-search" : "empty-state"} Clear search link restores Needs action`, async () => {
      emptyResults = true;
      invalidSearch = invalid;
      mount("view=needs_action&conversation=one");
      await search();
      const link = [...dom.root.querySelectorAll<HTMLAnchorElement>("a")].find((link) => link.textContent?.trim() === "Clear search")!;
      link.click();
      await settle();
      assertRoute("view=needs_action&conversation=one", "Needs action");
      expect(dom.root.querySelector("[data-mail-reader-heading]")).not.toBeNull();
    });
  }

  test("clearing after a reload restores Needs action", async () => {
    mount("q=invoice&searchFrom=view%3Dneeds_action");
    clearButton().click();
    await settle();
    assertRoute("view=needs_action", "Needs action");
  });

  test("Back after clearing shows the search again, and clearing it again returns to Needs action", async () => {
    mount();
    await search();
    clearButton().click();
    await settle();
    assertRoute("view=needs_action", "Needs action");
    history.back();
    await settle();
    assertRoute("searchFrom=view%3Dneeds_action&q=invoice", "Search results");
    expect(input().value).toBe("invoice");
    history.forward();
    await settle();
    assertRoute("view=needs_action", "Needs action");
    history.back();
    await settle();
    input().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    assertRoute("view=needs_action", "Needs action");
  });

  test("a tag view stays put when text is deleted before the debounce", async () => {
    mount(tagQuery);
    type("i");
    type("");
    await Bun.sleep(380);
    expect(location.pathname + location.search).toBe(`${path}?${tagQuery}`);
    expect(workspaceRequests).toEqual([]);
    expect(title()).toBe("Tagged mail");
  });

  test("clearing restores the starting list scroll", async () => {
    mount();
    scroller().scrollTop = 480;
    await search();
    scroller().scrollTop = 20;
    clearButton().click();
    await settle();
    assertRoute("view=needs_action", "Needs action");
    expect(scroller().scrollTop).toBe(480);
  });

  test("Back restores the starting list scroll", async () => {
    mount();
    scroller().scrollTop = 480;
    await search();
    scroller().scrollTop = 20;
    history.back();
    await settle();
    assertRoute("view=needs_action", "Needs action");
    expect(scroller().scrollTop).toBe(480);
  });

  for (const method of ["clear", "Back"]) {
    test(`${method} reloads the starting list's second page before restoring its scroll`, async () => {
      mount();
      await loadSecondPage();
      scroller().scrollTop = 480;
      await search();
      workspaceRequests = [];
      listRequests = [];
      scroller().scrollTop = 20;
      if (method === "clear") clearButton().click();
      else history.back();
      await settle();
      expect(workspaceRequests).toEqual([`${path}?view=needs_action`]);
      expect(listRequests).toEqual([`${path}?view=needs_action&cursor=needs-action-next`]);
      expect(title()).toBe("Needs action");
      expect(dom.root.querySelector('[data-conversation-id="page-two"]')).not.toBeNull();
      // Happy DOM does not clamp scrollTop, so the page request and rendered row guard the list's height too.
      expect(scroller().scrollTop).toBe(480);
    });
  }

  test("leaving while the starting list's extra page loads preserves the other view and its scroll", async () => {
    mount();
    await loadSecondPage();
    scroller().scrollTop = 480;
    await search();
    const response = Promise.withResolvers<Response>();
    heldCursorResponse = response.promise;
    workspaceRequests = [];
    listRequests = [];
    clearButton().click();
    await settle();
    expect(workspaceRequests).toEqual([`${path}?view=needs_action`]);
    expect(listRequests).toEqual([`${path}?view=needs_action&cursor=needs-action-next`]);
    scroller().scrollTop = 35;
    await clickLink("folder=Inbox1");
    assertRoute("folder=Inbox1", "Inbox");
    expect(scroller().scrollTop).toBe(35);
    response.resolve(Response.json(snapshotFor(`${path}?view=needs_action&cursor=needs-action-next`)));
    await settle();
    expect(workspaceRequests).toEqual([`${path}?view=needs_action`, `${path}?folder=Inbox1`]);
    expect(listRequests).toEqual([`${path}?view=needs_action&cursor=needs-action-next`]);
    expect(title()).toBe("Inbox");
    expect(dom.root.querySelector('[data-conversation-id="page-two"]')).toBeNull();
    expect(scroller().scrollTop).toBe(35);
  });

  test("choosing another view discards the starting scroll before a later visit", async () => {
    mount();
    scroller().scrollTop = 480;
    await search();
    scroller().scrollTop = 20;
    await clickLink("folder=Inbox1");
    assertRoute("folder=Inbox1", "Inbox");
    scroller().scrollTop = 35;
    await clickLink("");
    await clickLink("view=needs_action");
    assertRoute("view=needs_action", "Needs action");
    expect(scroller().scrollTop).toBe(35);
  });

  test("Back into a search from another view does not capture that view's scroll", async () => {
    mount();
    scroller().scrollTop = 480;
    await search();
    await clickLink("folder=Inbox1");
    assertRoute("folder=Inbox1", "Inbox");
    scroller().scrollTop = 120;
    history.back();
    await settle();
    assertRoute("searchFrom=view%3Dneeds_action&q=invoice", "Search results");
    scroller().scrollTop = 300;
    clearButton().click();
    await settle();
    assertRoute("view=needs_action", "Needs action");
    expect(scroller().scrollTop).toBe(300);
  });
});
