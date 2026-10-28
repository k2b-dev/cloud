import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { MailboxPageData } from "../service/workspace";
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
    const nav = await import("@k2b/ssr/nav");
    const actionQueues = await import("./_components/mail-action-queue");
    const ui = await import("@k2b/ui");
    const { readPageTrail } = ui;
    const { default: MailWorkspace } = await import("./MailWorkspace.island");
    return {
      readThemeFromCookieHeader,
      DEFAULT_MAIL_CONTACT_DIRECTORY,
      readMailUserPreferencesFromCookieHeader,
      readMailWorkspacePreferences,
      MailWorkspace,
      nav,
      actionQueues,
      readPageTrail,
      ui,
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

type RecordedRequest = { route: string; mailboxId: string; href: string; signal: AbortSignal | null | undefined };

describe.skipIf(isServer)("Mail workspace mailbox switches", () => {
  const m = modules!;
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  let dom: DomTestHarness;
  let dispose = () => {};
  let requests: RecordedRequest[];
  let failure: number | "network" | "json" | null;
  let structureResponse: Promise<Response> | undefined;
  const held = new Map<string, Promise<void>>();
  const mailboxes = [data.mailbox, { ...data.mailbox, id: "Box002", name: "Sales" }, { ...data.mailbox, id: "Box003", name: "Projects" }];
  const snapshotFor = (href: string): MailboxPageData => {
    const url = new URL(href, "http://localhost");
    const box = mailboxes.find((box) => url.pathname === `/app/mail/${box.id}`)!;
    const folderId = url.searchParams.get("folder");
    const title = folderId ? "Filed" : `${box.name} mail`;
    return {
      ...structuredClone(data),
      mailbox: box,
      folderId,
      selectedConversationId: url.searchParams.get("conversation"),
      listTitle: title,
      listItems: [mailTestRow(`${box.id}-row`, { subject: title, unread: false, unreadFolderIds: [] })],
    };
  };
  const navigationSpies = () => ({
    document: spyOn(m.nav, "documentNavigate").mockImplementation(() => {}),
    assign: spyOn(dom.window.location, "assign").mockImplementation(() => {}),
    replace: spyOn(dom.window.location, "replace").mockImplementation(() => {}),
    push: spyOn(dom.window.history, "pushState"),
  });
  let spies: ReturnType<typeof navigationSpies>;
  beforeEach(() => {
    setSystemTime(new Date(now));
    dom = createDomTestHarness();
    dom.root.classList.add("cloud-app-canvas");
    dom.root.dataset.appBase = "/app/mail";
    Object.defineProperty(globalThis, "CSS", { value: dom.window.CSS, configurable: true });
    Reflect.set(globalThis, "WebSocket", FakeWebSocket);
    FakeWebSocket.instances = [];
    requests = [];
    held.clear();
    failure = null;
    structureResponse = undefined;
    spies = navigationSpies();
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://localhost");
        const route = url.pathname.split("/").at(-1)!;
        if ((route === "merge" || route === "split") && structureResponse) return structureResponse;
        if (route === "workspace-route" || route === "workspace-list") {
          const mailboxId = url.pathname.split("/").at(-2)!;
          const href = url.searchParams.get("href")!;
          requests.push({ route, mailboxId, href, signal: init?.signal ?? (input instanceof Request ? input.signal : undefined) });
          await held.get(mailboxId);
          if (failure === "network") throw new TypeError("Network unavailable");
          if (failure === "json") return new Response("{invalid json");
          return Response.json(failure ? { error: "denied" } : snapshotFor(href), { status: failure ?? 200 });
        }
        if (route === "activity") return Response.json({ items: [], nextCursor: null });
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
    for (const spy of Object.values(spies)) spy.mockRestore();
    globalThis.fetch = originalFetch;
    Reflect.set(globalThis, "WebSocket", originalWebSocket);
    dom.cleanup();
    if (originalCss) Object.defineProperty(globalThis, "CSS", originalCss);
    else Reflect.deleteProperty(globalThis, "CSS");
    setSystemTime();
  });
  const mount = (requestPath = path, snapshot = snapshotFor(requestPath)) => {
    dom.window.history.replaceState(null, "", requestPath);
    dispose = render(
      () =>
        createComponent(m.MailWorkspace, {
          data: snapshot,
          requestPath,
          currentUserId: "user-1",
          currentUserEmail: "reader@example.test",
          contactDirectory: m.DEFAULT_MAIL_CONTACT_DIRECTORY,
          cloudUrl: "https://cloud.example",
          dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
          initialPreferences: m.readMailWorkspacePreferences(""),
          initialUserPreferences: m.readMailUserPreferencesFromCookieHeader("", MAILBOX_ID),
          initialTheme: m.readThemeFromCookieHeader(""),
          calendarIntegrationAvailable: false,
          sidebar: { mailboxes: mailboxes.map((box) => ({ ...box, receivingAddress: null })), pinnedMailboxIds: [], hiddenMailboxIds: [] },
        }),
      dom.root,
    );
  };
  const link = (id: string) => dom.root.querySelector<HTMLAnchorElement>(`.mail-sidebar [data-mailbox="${id}"] a[href="/app/mail/${id}"]`)!;
  const heading = () => dom.root.querySelector("[data-mail-list-heading]")?.textContent;
  const shown = (id: string) => {
    expect(dom.root.querySelector(`.mail-sidebar [data-mailbox="${id}"]`)?.getAttribute("data-open")).toBe("true");
    expect(dom.root.querySelector('[role="group"][aria-label^="Folders of"]')?.getAttribute("aria-label")).toBe(
      `Folders of ${mailboxes.find((b) => b.id === id)!.name}`,
    );
    expect(dom.root.querySelector("[data-mail-conversation-list] [data-conversation-id]")?.getAttribute("data-conversation-id")).toBe(
      `${id}-row`,
    );
  };
  const noDocument = () => {
    expect(spies.document).not.toHaveBeenCalled();
    expect(spies.assign).not.toHaveBeenCalled();
    expect(spies.replace).not.toHaveBeenCalled();
  };
  const hold = (id: string) => {
    let release = () => {};
    held.set(
      id,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return release;
  };
  const pop = async (href: string) => {
    dom.window.history.replaceState(null, "", href);
    dom.window.dispatchEvent(new dom.window.PopStateEvent("popstate"));
    await settle();
  };
  const scope = () => {
    const detail: { sources: { scope?: { type: string; id: string } }[] } = { sources: [] };
    window.dispatchEvent(new CustomEvent("cloud.page-context.collect", { detail }));
    return detail.sources.map((source) => source.scope);
  };

  test("one snapshot preserves the sidebar, workspace roots and focused link, and updates title, trail and scope", async () => {
    mount();
    const sidebar = dom.root.querySelector(".mail-sidebar");
    const root = dom.root.querySelector(".mail-workspace");
    const head = dom.root.querySelector(".k2b-app-workspace__head");
    const b = link("Box002");
    b.focus();
    expect(scope()).toEqual([{ type: "mail.mailbox", id: MAILBOX_ID }]);
    b.click();
    await settle();
    expect(requests.map(({ route, mailboxId, href }) => ({ route, mailboxId, href }))).toEqual([
      { route: "workspace-route", mailboxId: "Box002", href: "/app/mail/Box002" },
    ]);
    noDocument();
    expect(dom.root.querySelector(".mail-sidebar")).toBe(sidebar);
    expect(dom.root.querySelector(".mail-workspace")).toBe(root);
    expect(dom.root.querySelector(".k2b-app-workspace__head")).toBe(head);
    expect(link("Box002")).toBe(b);
    expect(dom.document.activeElement).toBe(b);
    shown("Box002");
    expect(dom.root.querySelector('[data-mailbox="Box001"]')?.getAttribute("data-open")).toBeNull();
    expect(heading()).toBe("Sales mail");
    expect(spies.push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/app/mail/Box002");
    expect(document.title).toBe("Sales");
    expect(m.readPageTrail()).toEqual({ title: "Sales", ancestors: [] });
    expect(scope()).toEqual([{ type: "mail.mailbox", id: "Box002" }]);
  });

  test("A → B → C aborts B, leaves the frame in place while busy, and only C commits", async () => {
    mount();
    const releaseB = hold("Box002");
    const releaseC = hold("Box003");
    link("Box002").click();
    await settle();
    expect(dom.root.querySelector(".k2b-app-workspace__main")?.getAttribute("aria-busy")).toBe("true");
    shown(MAILBOX_ID);
    link("Box003").click();
    await settle();
    expect(requests[0]?.signal?.aborted).toBe(true);
    releaseC();
    await settle();
    releaseB();
    await settle();
    shown("Box003");
    expect(spies.push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname).toBe("/app/mail/Box003");
    noDocument();
  });

  for (const status of [401, 403, 404, 500, "network", "json"] as const)
    test(`${status} falls back to the document and keeps A shown`, async () => {
      mount();
      failure = status;
      link("Box002").click();
      await settle();
      shown(MAILBOX_ID);
      expect(spies.document).toHaveBeenCalledWith("http://localhost/app/mail/Box002", { replace: false });
      expect(spies.push).not.toHaveBeenCalled();
      expect(dom.root.querySelector(".k2b-app-workspace__main")?.getAttribute("aria-busy")).toBe("false");
    });

  test("Back and Forward across listed mailboxes keep the island and query without pushing", async () => {
    mount();
    link("Box002").click();
    await settle();
    spies.push.mockClear();
    const sidebar = dom.root.querySelector(".mail-sidebar");
    await pop(path);
    shown(MAILBOX_ID);
    await pop("/app/mail/Box002?folder=Filed1");
    shown("Box002");
    expect(heading()).toBe("Filed");
    expect(dom.root.querySelector(".mail-sidebar")).toBe(sidebar);
    expect(spies.push).not.toHaveBeenCalled();
    noDocument();
  });

  test("popstate outside the listed mailbox workspaces loads the document with replace", async () => {
    mount();
    await pop("/app/mail/Absent");
    expect(spies.document).toHaveBeenCalledWith("http://localhost/app/mail/Absent", { replace: true });
    expect(requests).toHaveLength(0);
  });

  test("a failed history switch replaces the document without pushing", async () => {
    mount();
    failure = 403;
    await pop("/app/mail/Box002");
    shown(MAILBOX_ID);
    expect(spies.document).toHaveBeenCalledWith("http://localhost/app/mail/Box002", { replace: true });
    expect(spies.push).not.toHaveBeenCalled();
  });

  test("a folder click in A cancels a pending switch to B and cannot add B to history", async () => {
    mount();
    const release = hold("Box002");
    link("Box002").click();
    await settle();
    dom.root.querySelector<HTMLAnchorElement>(`.mail-sidebar a[href="${path}?folder=Filed1"]`)!.click();
    await settle();
    expect(requests[0]?.signal?.aborted).toBe(true);
    release();
    await settle();
    shown(MAILBOX_ID);
    expect(heading()).toBe("Filed");
    expect(window.location.pathname + window.location.search).toBe(`${path}?folder=Filed1`);
    expect(spies.push).toHaveBeenCalledTimes(1);
    noDocument();
  });

  test("clicking the shown mailbox cancels a pending switch even when its URL is already current", async () => {
    mount();
    const release = hold("Box002");
    link("Box002").click();
    await settle();
    link(MAILBOX_ID).click();
    await settle();
    expect(requests[0]?.signal?.aborted).toBe(true);
    release();
    await settle();
    shown(MAILBOX_ID);
    expect(window.location.pathname + window.location.search).toBe(path);
    noDocument();
  });

  test("clicking the active folder also cancels a pending mailbox switch", async () => {
    const folderPath = `${path}?folder=Filed1`;
    mount(folderPath);
    const release = hold("Box002");
    link("Box002").click();
    await settle();
    dom.root.querySelector<HTMLAnchorElement>(`.mail-sidebar a[href="${folderPath}"]`)!.click();
    await settle();
    expect(requests[0]?.signal?.aborted).toBe(true);
    release();
    await settle();
    shown(MAILBOX_ID);
    expect(window.location.pathname + window.location.search).toBe(folderPath);
    noDocument();
  });

  test("clicking the current view tab also cancels a pending mailbox switch", async () => {
    mount();
    const release = hold("Box002");
    link("Box002").click();
    await settle();
    const currentTab = dom.root.querySelector<HTMLAnchorElement>(`.k2b-app-workspace__head-views a[href="${path}"]`)!;
    expect(currentTab).not.toBeNull();
    currentTab.click();
    await settle();
    expect(requests[0]?.signal?.aborted).toBe(true);
    release();
    await settle();
    shown(MAILBOX_ID);
    expect(window.location.pathname + window.location.search).toBe(path);
    noDocument();
  });

  test("a pending collapse preference flushes on disposal and becomes the new session's preference", async () => {
    mount(`${path}?conversation=Box001-row`);
    dom.root.querySelector<HTMLButtonElement>('.k2b-app-workspace__head button[aria-label="Options for Support"]')!.click();
    await Bun.sleep(0);
    const item = [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Hide conversation list",
    )!;
    expect(item).not.toBeUndefined();
    item.click();
    link("Box002").click();
    await settle();
    expect(m.readMailWorkspacePreferences(document.cookie).listCollapsed).toBe(true);
    shown("Box002");
  });

  test("session disposal flushes queued writes even while an earlier write is still running", async () => {
    const queue = m.actionQueues.createMailActionQueue(1);
    const factory = spyOn(m.actionQueues, "createMailActionQueue").mockReturnValueOnce(queue);
    try {
      mount();
    } finally {
      factory.mockRestore();
    }
    let releaseFirst = () => {};
    const heldWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.enqueue("first", () => heldWrite);
    let secondStarted = false;
    const second = queue.enqueue("second", async () => {
      secondStarted = true;
    });
    try {
      expect(secondStarted).toBe(false);
      link("Box002").click();
      await settle();
      shown("Box002");
      expect(secondStarted).toBe(true);
    } finally {
      releaseFirst();
      await Promise.all([first.result, second.result]);
    }
  });

  test("the shown mailbox's row opens its default list in place", async () => {
    mount(`${path}?folder=Filed1`);
    link(MAILBOX_ID).click();
    await settle();
    expect(requests.map(({ route, mailboxId, href }) => ({ route, mailboxId, href }))).toEqual([
      { route: "workspace-route", mailboxId: MAILBOX_ID, href: path },
    ]);
    shown(MAILBOX_ID);
    expect(heading()).toBe("Support mail");
    expect(window.location.pathname + window.location.search).toBe(path);
    noDocument();
  });

  test("Back delayed on A followed by Forward to the still-shown B cancels A and keeps URL and scope on B", async () => {
    mount();
    link("Box002").click();
    await settle();
    const release = hold(MAILBOX_ID);
    await pop(path);
    const pendingA = requests.findLast((request) => request.mailboxId === MAILBOX_ID)!;
    await pop("/app/mail/Box002");
    expect(pendingA.signal?.aborted).toBe(true);
    release();
    await settle();
    shown("Box002");
    expect(window.location.pathname).toBe("/app/mail/Box002");
    expect(scope()).toEqual([{ type: "mail.mailbox", id: "Box002" }]);
    expect(spies.push).toHaveBeenCalledTimes(1);
    noDocument();
  });

  test("a mailbox switch supersedes an older pending folder navigation before it can push history", async () => {
    mount();
    const releaseA = hold(MAILBOX_ID);
    const releaseB = hold("Box002");
    dom.root.querySelector<HTMLAnchorElement>(`.mail-sidebar a[href="${path}?folder=Filed1"]`)!.click();
    await settle();
    link("Box002").click();
    await settle();
    releaseA();
    await settle();
    expect(spies.push).not.toHaveBeenCalled();
    releaseB();
    await settle();
    shown("Box002");
    expect(spies.push).toHaveBeenCalledTimes(1);
    expect(window.location.pathname + window.location.search).toBe("/app/mail/Box002");
    noDocument();
  });

  test("a mailbox switch cancels older pending search text", async () => {
    mount();
    dom.root.querySelector<HTMLButtonElement>("[data-mail-search-trigger]")?.click();
    const input = dom.root.querySelector<HTMLInputElement>('input[name="q"]')!;
    input.value = "invoice";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    link("Box002").click();
    await Bun.sleep(380);
    shown("Box002");
    expect(requests.map(({ mailboxId }) => mailboxId)).toEqual(["Box002"]);
    expect(spies.push).toHaveBeenCalledTimes(1);
    noDocument();
  });

  test("a live refresh of A leaves a pending switch to B alone", async () => {
    mount();
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "ready", id: "1", cursor: data.initialLiveCursor });
    await settle();
    const releaseB = hold("Box002");
    link("Box002").click();
    await settle();
    socket.message({ t: "event", id: "1", cursor: "s6t.mail.5", data: { conversationId: null } });
    await settle();
    expect(requests.some(({ mailboxId }) => mailboxId === MAILBOX_ID)).toBe(true);
    expect(requests[0]?.signal?.aborted).toBe(false);
    releaseB();
    await settle();
    shown("Box002");
    expect(spies.push).toHaveBeenCalledTimes(1);
    noDocument();
  });

  test("an older successful merge cannot cancel a newer pending mailbox switch", async () => {
    let releaseMerge = () => {};
    structureResponse = new Promise<Response>((resolve) => {
      releaseMerge = () => resolve(Response.json({}));
    });
    const choose = spyOn(m.ui, "openSpotlightSearch").mockResolvedValue({
      label: "Target",
      value: { conversationId: "target", revision: 1, subject: "Target", participantSummary: "Sender" },
    });
    const confirm = spyOn(m.ui.prompts, "confirm").mockResolvedValue(true);
    try {
      mount();
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Actions for Support mail"]')!.click();
      await Bun.sleep(0);
      const merge = [...dom.root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === "Merge with another conversation",
      )!;
      expect(merge).not.toBeUndefined();
      merge.click();
      await settle();
      expect(confirm).toHaveBeenCalledTimes(1);
      const releaseB = hold("Box002");
      link("Box002").click();
      await settle();
      releaseMerge();
      await settle();
      expect(dom.document.body.textContent).toContain("Conversations merged");
      expect(requests[0]?.signal?.aborted).toBe(false);
      releaseB();
      await settle();
      shown("Box002");
      expect(window.location.pathname).toBe("/app/mail/Box002");
      noDocument();
    } finally {
      choose.mockRestore();
      confirm.mockRestore();
    }
  });

  test("an older successful split cannot cancel a newer pending mailbox switch", async () => {
    let releaseSplit = () => {};
    structureResponse = new Promise<Response>((resolve) => {
      releaseSplit = () => resolve(Response.json({ created: { id: "split-conversation" } }));
    });
    const confirm = spyOn(m.ui.prompts, "confirm").mockResolvedValue(true);
    const source = `${path}?conversation=Box001-row`;
    const snapshot = snapshotFor(source);
    snapshot.listItems[0]!.messageCount = 2;
    const message: MailboxPageData["detailMessages"][number] = {
      id: "Msg001",
      subject: "Support mail",
      messageId: "<split@example.test>",
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
      plainText: "Message body",
      sanitizedHtml: null,
      forwardText: "Message body",
      selectedHeaders: {},
      sourceAvailable: true,
      mailingList: null,
      remoteContent: { imageIds: [], allowedByRule: false, sender: "sender@example.test", domain: "example.test" },
      delivery: null,
      attachments: [],
    };
    snapshot.detailMessages = [message, { ...message, id: "Msg002", messageId: "<split-2@example.test>" }];
    try {
      mount(source, snapshot);
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="More conversation actions"]')!.click();
      await Bun.sleep(0);
      const split = [...dom.root.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === "Start new conversation from latest message",
      )!;
      expect(split).not.toBeUndefined();
      split.click();
      await settle();
      expect(confirm).toHaveBeenCalledTimes(1);
      const releaseB = hold("Box002");
      link("Box002").click();
      await settle();
      releaseSplit();
      await settle();
      expect(dom.document.body.textContent).toContain("New conversation created");
      expect(requests[0]?.signal?.aborted).toBe(false);
      releaseB();
      await settle();
      shown("Box002");
      expect(window.location.pathname).toBe("/app/mail/Box002");
      noDocument();
    } finally {
      confirm.mockRestore();
    }
  });

  test("modified and middle mailbox clicks keep the native link behavior", async () => {
    mount();
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...options });
      link("Box002").dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();
    expect(requests).toHaveLength(0);
    shown(MAILBOX_ID);
    expect(spies.push).not.toHaveBeenCalled();
  });

  test("typing in A cancels B before the search debounce fires", async () => {
    mount();
    const release = hold("Box002");
    link("Box002").click();
    await settle();
    dom.root.querySelector<HTMLButtonElement>("[data-mail-search-trigger]")?.click();
    const input = dom.root.querySelector<HTMLInputElement>('input[name="q"]')!;
    input.value = "invoice";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(requests[0]?.signal?.aborted).toBe(true);
    release();
    await settle();
    shown(MAILBOX_ID);
    expect(spies.push).not.toHaveBeenCalled();
    noDocument();
  });
});
