import {
  afterEach,
  beforeEach,
  describe,
  expect,
  beforeEach as pinClockBeforeEach,
  afterEach as restoreClockAfterEach,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import { MAIL_ACTION_OUTCOME_TTL_MS } from "../command-outcomes";
import { type ConversationTriageInput, conversationTriageInputSchema, conversationTriageUndoInputSchema } from "../contracts";
import type { MailboxPageData } from "../service/workspace";
import { MAIL_BULK_CONCURRENCY } from "./_components/mail-bulk-actions";
import { MAIL_ROW_LEAVE_MS } from "./_components/mail-list-projection";
import { mailTestRow as fixtureMailRow, mailTestFolder } from "./_components/mail-list-test-fixtures";

const mailTestRow = (id: string) =>
  fixtureMailRow(id, { activeFolderIds: ["Inbox1"], unreadFolderIds: ["Inbox1"], sourceFolderId: "Inbox1" });
const commandId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

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
  folderId: "Inbox1",
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

type Frame = { t: string; id?: string; channel?: string; scope?: unknown; after?: string };
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: Frame[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const settle = () => Bun.sleep(30);

describe("Mail list actions", () => {
  if (isServer) {
    test.skip("runs in the browser-conditions process", () => {});
    return;
  }
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalCss = Object.getOwnPropertyDescriptor(globalThis, "CSS");
  let dom: DomTestHarness;
  let dispose = () => {};
  let snapshot: MailboxPageData;
  let requests: { body: ConversationTriageInput; conversationId: string; keepalive: boolean | undefined }[];
  let undoRequests: string[][];
  let actionResponse: (index: number) => Promise<Response>;
  let outcomeState: "queued" | "failed" | "confirmed";
  let undoResponse: () => Promise<Response>;
  let workspaceRequests: string[];
  let workspaceResponse: (href: string) => Promise<Response>;

  beforeEach(() => {
    dom = createDomTestHarness();
    Object.defineProperty(globalThis, "CSS", { value: dom.window.CSS, configurable: true });
    FakeWebSocket.instances = [];
    Reflect.set(globalThis, "WebSocket", FakeWebSocket);
    snapshot = structuredClone(data);
    requests = [];
    undoRequests = [];
    outcomeState = "queued";
    workspaceRequests = [];
    workspaceResponse = async (href) =>
      Response.json(
        href.includes("conversation=")
          ? snapshot
          : { ...snapshot, selectedConversationId: null, selectedMessageId: null, detailMessages: [] },
      );
    actionResponse = async (index) => Response.json({ commands: [{ id: commandId(index), state: "queued" }] });
    undoResponse = async () => Response.json({ commands: undoRequests.at(-1)!.map((id) => ({ id, outcome: "cancelled", inverse: null })) });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/workspace-route")) {
          const href = new URL(url, "http://localhost").searchParams.get("href") ?? "";
          workspaceRequests.push(href);
          return workspaceResponse(href);
        }
        const body = input instanceof Request ? await input.clone().text() : String(init?.body ?? "{}");
        if (url.endsWith("/actions/undo")) {
          undoRequests.push(conversationTriageUndoInputSchema.parse(JSON.parse(body)).commandIds);
          return undoResponse();
        }
        if (url.endsWith("/actions")) {
          const conversationId = url.split("/conversations/")[1]!.split("/")[0]!;
          requests.push({
            body: conversationTriageInputSchema.parse(JSON.parse(body)),
            conversationId,
            keepalive: input instanceof Request ? input.keepalive : init?.keepalive,
          });
          return actionResponse(requests.length);
        }
        if (url.endsWith("/commands/outcomes"))
          return Response.json(
            requests.map((_, index) => ({
              id: commandId(index + 1),
              state: outcomeState,
              code: outcomeState === "failed" ? "PROVIDER_RIGHTS_CHANGED" : null,
            })),
          );
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
  });
  const mount = (overrides: Partial<MailboxPageData> = {}) => {
    const {
      MailWorkspace,
      DEFAULT_MAIL_CONTACT_DIRECTORY,
      readMailWorkspacePreferences,
      readMailUserPreferencesFromCookieHeader,
      readThemeFromCookieHeader,
    } = modules!;
    snapshot = { ...snapshot, ...overrides };
    const path = `/app/mail/${MAILBOX_ID}?${snapshot.folderId ? `folder=${snapshot.folderId}` : `view=${snapshot.activeView}`}${snapshot.selectedConversationId ? `&conversation=${snapshot.selectedConversationId}` : ""}${snapshot.selectedMessageId ? `&message=${snapshot.selectedMessageId}` : ""}`;
    dom.window.history.replaceState(null, "", path);
    dispose = render(
      () =>
        createComponent(MailWorkspace, {
          data: structuredClone(snapshot),
          requestPath: path,
          currentUserId: "user-1",
          currentUserEmail: "reader@example.test",
          contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
          dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
          initialPreferences: readMailWorkspacePreferences(""),
          initialUserPreferences: readMailUserPreferencesFromCookieHeader("", MAILBOX_ID),
          initialTheme: readThemeFromCookieHeader(""),
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
  const row = (id: string) =>
    dom.root.querySelector<HTMLElement>(`.mail-list-entry[data-message-id="${id}"]`) ??
    dom.root.querySelector<HTMLElement>(`.mail-list-entry[data-conversation-id="${id}"]`);
  const rowIds = () =>
    [...dom.root.querySelectorAll<HTMLElement>(".mail-list-entry")].map((row) => row.dataset.messageId ?? row.dataset.conversationId);
  const toastAction = (label: string) => {
    const button = [...dom.document.querySelectorAll<HTMLButtonElement>(".k2b-toast__action")].find(
      (button) => button.textContent === label,
    );
    if (!button) throw new Error(`No toast action ${label}`);
    return button;
  };
  const menuAction = async (id: string, label: string) => {
    const trigger = row(id)?.querySelector<HTMLButtonElement>(`button[aria-label="Actions for ${id}"]`);
    if (!trigger) throw new Error(`No action trigger for ${id}`);
    trigger.click();
    await Bun.sleep(0);
    const item = [...row(id)!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label);
    if (!item) throw new Error(`No menu action ${label}`);
    item.click();
  };
  const refresh = async () => {
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.open();
    socket.message({ t: "resync", id: "1", cursor: "s6t.mail.10" });
    await settle();
  };
  const badge = (href: string) => dom.root.querySelector(`a[href="${href}"]`)?.textContent;

  test("Delete projects before response: leaving, inert, Undo, unread badge and focus; then hidden", async () => {
    const hold = deferred<Response>();
    actionResponse = () => hold.promise;
    mount();
    row("one")!.querySelector<HTMLElement>(".mail-list-row")!.focus();
    await menuAction("one", "Move to Trash");
    expect(row("one")?.dataset.leaving).toBe("true");
    expect(row("one")?.hasAttribute("inert")).toBe(true);
    expect(row("one")?.getAttribute("aria-hidden")).toBe("true");
    expect(dom.document.activeElement).toBe(row("two")?.querySelector(".mail-list-row") ?? null);
    expect(toastAction("Undo").closest(".k2b-toast")?.textContent).toContain("Conversation moved to Trash");
    expect(badge(`/app/mail/${MAILBOX_ID}?folder=Inbox1`)).toContain("2");
    await Bun.sleep(MAIL_ROW_LEAVE_MS + 20);
    expect(rowIds()).toEqual(["two", "three"]);
    expect(requests[0]?.keepalive).toBe(true);
    hold.resolve(Response.json({ commands: [{ id: commandId(1), state: "queued" }] }));
    await settle();
  });
  test("Needs action count goes down once and a stale refresh cannot bring the pending row back", async () => {
    mount({ folderId: null, activeView: "needs_action" });
    await menuAction("one", "Move to Trash");
    expect(badge(`/app/mail/${MAILBOX_ID}?view=needs_action`)).toContain("2");
    await Bun.sleep(MAIL_ROW_LEAVE_MS + 20);
    await refresh();
    expect(rowIds()).toEqual(["two", "three"]);
    outcomeState = "confirmed";
    snapshot = {
      ...snapshot,
      listItems: snapshot.listItems.slice(1),
      viewCounts: { ...snapshot.viewCounts, needs_action: 2 },
      folders: snapshot.folders.map((folder) => (folder.id === "Inbox1" ? { ...folder, unread: 2 } : folder)),
    };
    await Bun.sleep(1_050);
    expect(rowIds()).toEqual(["two", "three"]);
    expect(badge(`/app/mail/${MAILBOX_ID}?view=needs_action`)).toContain("2");
  });
  test("500 restores the original index and an error toast Retry reuses the idempotency key", async () => {
    const hold = deferred<Response>();
    actionResponse = () => hold.promise;
    mount();
    await menuAction("two", "Move to Trash");
    await Bun.sleep(MAIL_ROW_LEAVE_MS + 20);
    expect(rowIds()).toEqual(["one", "three"]);
    hold.resolve(Response.json({ error: { message: "Rejected" } }, { status: 500 }));
    await settle();
    expect(rowIds()).toEqual(["one", "two", "three"]);
    expect(toastAction("Try again").closest(".k2b-toast")?.getAttribute("data-tone")).toBe("danger");
    const key = requests[0]!.body.idempotencyKey;
    actionResponse = async () => Response.json({ commands: [{ id: commandId(2), state: "queued" }] });
    toastAction("Try again").click();
    await settle();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body.idempotencyKey).toBe(key);
  });
  test("a later failed command restores the row and offers retry", async () => {
    mount();
    await menuAction("one", "Move to Trash");
    await Bun.sleep(MAIL_ROW_LEAVE_MS + 20);
    expect(row("one")).toBeNull();
    outcomeState = "failed";
    await Bun.sleep(1_050);
    expect(rowIds()).toEqual(["one", "two", "three"]);
    expect(toastAction("Try again").closest(".k2b-toast")?.textContent).toContain("The mail account no longer allows this change.");
  });
  test("flag then Delete submits in click order while the first response is delayed", async () => {
    const hold = deferred<Response>();
    actionResponse = (index) =>
      index === 1 ? hold.promise : Promise.resolve(Response.json({ commands: [{ id: commandId(2), state: "queued" }] }));
    mount();
    await menuAction("one", "Flag");
    await menuAction("one", "Move to Trash");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body.kind).toBe("change_state");
    hold.resolve(Response.json({ commands: [{ id: commandId(1), state: "queued" }] }));
    await settle();
    expect(requests.map((request) => request.body.kind)).toEqual(["change_state", "move_to_role"]);
  });
  test("Undo before send cancels Delete queued behind a flag, bringing back the row", async () => {
    const hold = deferred<Response>();
    actionResponse = () => hold.promise;
    mount();
    await menuAction("one", "Flag");
    await menuAction("one", "Move to Trash");
    toastAction("Undo").click();
    expect(rowIds()).toEqual(["one", "two", "three"]);
    hold.resolve(Response.json({ commands: [{ id: commandId(1), state: "queued" }] }));
    await settle();
    expect(requests).toHaveLength(1);
    expect(undoRequests).toEqual([]);
  });
  test("Undo after send holds exactly one row across absent and present snapshots", async () => {
    const hold = deferred<Response>();
    undoResponse = () => hold.promise;
    mount();
    await menuAction("two", "Move to Trash");
    await settle();
    toastAction("Undo").click();
    expect(rowIds()).toEqual(["one", "two", "three"]);
    await settle();
    expect(undoRequests).toEqual([[commandId(1)]]);
    snapshot = { ...snapshot, listItems: [mailTestRow("one"), mailTestRow("three")] };
    await refresh();
    expect(rowIds()).toEqual(["one", "two", "three"]);
    snapshot = { ...snapshot, listItems: [mailTestRow("one"), mailTestRow("two"), mailTestRow("three")] };
    await refresh();
    expect(rowIds()).toEqual(["one", "two", "three"]);
    hold.resolve(Response.json({ commands: [{ id: commandId(1), outcome: "cancelled", inverse: null }] }));
    await settle();
    expect(rowIds()).toEqual(["one", "two", "three"]);
  });
  test("Undo after send announces Undone only after pending resolves to a queued inverse", async () => {
    const reversed = deferred<Response>();
    const polled = deferred<void>();
    undoResponse = async () => {
      if (undoRequests.length === 1) return Response.json({ commands: [{ id: commandId(1), outcome: "pending", inverse: null }] });
      polled.resolve();
      return reversed.promise;
    };
    // Screen-reader announcements land in the live region after a short delay.
    const announced = async () => {
      await Bun.sleep(150);
      return dom.document.querySelector("[data-k2b-live]")?.textContent ?? "";
    };
    mount();
    await menuAction("two", "Move to Trash");
    await settle();
    toastAction("Undo").click();
    await settle();
    expect(undoRequests).toEqual([[commandId(1)]]);
    expect(await announced()).not.toContain("Undone");
    // The runner's first poll waits a real second; hold its answer.
    await polled.promise;
    expect(undoRequests).toEqual([[commandId(1)], [commandId(1)]]);
    expect(await announced()).not.toContain("Undone");
    reversed.resolve(
      Response.json({ commands: [{ id: commandId(1), outcome: "reversed", inverse: { id: commandId(2), state: "queued", code: null } }] }),
    );
    await settle();
    expect(await announced()).toContain("Undone");
  });
  test("Undo still polls after the browser horizon so the server can answer at its later deadline", async () => {
    let wallClock = Date.now();
    const clock = spyOn(Date, "now").mockImplementation(() => wallClock);
    undoResponse = async () => {
      if (undoRequests.length === 1) {
        wallClock += MAIL_ACTION_OUTCOME_TTL_MS;
        return Response.json({ commands: [{ id: commandId(1), outcome: "pending", inverse: null }] });
      }
      return Response.json({ commands: [{ id: commandId(1), outcome: "unavailable", inverse: null }] });
    };
    try {
      mount();
      await menuAction("two", "Move to Trash");
      await settle();
      toastAction("Undo").click();
      await Bun.sleep(1_100);
      expect(undoRequests).toEqual([[commandId(1)], [commandId(1)]]);
    } finally {
      clock.mockRestore();
    }
  });
  test("bulk Delete projects all three, ends selection, and one Undo restores their order", async () => {
    const hold = deferred<Response>();
    actionResponse = () => hold.promise;
    mount();
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Select conversations"]')!.click();
    for (const checkbox of dom.root.querySelectorAll<HTMLInputElement>('.mail-list-entry input[type="checkbox"]')) checkbox.click();
    const trigger = dom.root.querySelector<HTMLButtonElement>('button[aria-label="More selected conversation actions"]');
    if (!trigger) throw new Error("No bulk menu");
    trigger.click();
    await Bun.sleep(0);
    const item = [...trigger.closest(".k2b-dropdown")!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Move to Trash",
    );
    if (!item) throw new Error("No bulk Delete");
    item.click();
    expect(dom.root.querySelectorAll('[data-leaving="true"]')).toHaveLength(3);
    expect(dom.root.querySelector('.mail-list-entry input[type="checkbox"]')).toBeNull();
    expect(dom.document.querySelectorAll(".k2b-toast__action")).toHaveLength(1);
    await Bun.sleep(MAIL_ROW_LEAVE_MS + 20);
    expect(rowIds()).toEqual([]);
    toastAction("Undo").click();
    expect(rowIds()).toEqual(["one", "two", "three"]);
    for (const request of requests) expect(request.body.kind).toBe("move_to_role");
    hold.resolve(Response.json({ commands: [{ id: commandId(1), state: "queued" }] }));
    await settle();
  });
  test("pagehide flushes bulk Delete submissions past the concurrency bound", async () => {
    const hold = deferred<Response>();
    actionResponse = () => hold.promise;
    const rows = Array.from({ length: MAIL_BULK_CONCURRENCY + 2 }, (_, index) => mailTestRow(`row-${index}`));
    mount({ listItems: rows });
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Select conversations"]')!.click();
    for (const checkbox of dom.root.querySelectorAll<HTMLInputElement>('.mail-list-entry input[type="checkbox"]')) checkbox.click();
    const trigger = dom.root.querySelector<HTMLButtonElement>('button[aria-label="More selected conversation actions"]')!;
    trigger.click();
    await Bun.sleep(0);
    const item = [...trigger.closest(".k2b-dropdown")!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Move to Trash",
    );
    if (!item) throw new Error("No bulk Delete");
    item.click();
    await settle();
    expect(requests).toHaveLength(MAIL_BULK_CONCURRENCY);
    dom.window.dispatchEvent(new dom.window.Event("pagehide"));
    await settle();
    expect(requests.map((request) => request.conversationId)).toEqual(rows.map((row) => row.id));
    expect(requests.every((request) => request.keepalive)).toBe(true);
    dispose();
    hold.resolve(Response.json({ commands: [] }));
    await settle();
  });
  test("confirmed Delete survives a failed refresh and releases on the next applied snapshot", async () => {
    mount();
    await menuAction("one", "Move to Trash");
    await Bun.sleep(MAIL_ROW_LEAVE_MS + 20);
    expect(rowIds()).toEqual(["two", "three"]);
    workspaceResponse = async () => Response.json({ error: { message: "Refresh unavailable" } }, { status: 500 });
    outcomeState = "confirmed";
    await Bun.sleep(1_050);
    expect(workspaceRequests).toHaveLength(1);
    expect(rowIds()).toEqual(["two", "three"]);
    expect(
      [...dom.document.querySelectorAll(".k2b-toast")].some((notice) =>
        notice.textContent?.includes("Could not refresh this mailbox yet. Reload to confirm the latest state."),
      ),
    ).toBe(true);
    snapshot = {
      ...snapshot,
      listItems: snapshot.listItems.filter((item) => item.id !== "one"),
      folders: snapshot.folders.map((folder) => (folder.id === "Inbox1" ? { ...folder, unread: 2 } : folder)),
    };
    workspaceResponse = async () => Response.json(snapshot);
    await refresh();
    expect(rowIds()).toEqual(["two", "three"]);
    expect(badge(`/app/mail/${MAILBOX_ID}?folder=Inbox1`)).toContain("2");
    // A later server snapshot can show the same conversation again once its removal was released.
    snapshot = { ...snapshot, listItems: data.listItems };
    await refresh();
    expect(rowIds()).toEqual(["one", "two", "three"]);
  });
  test("two Deletes settling in one tick share one refresh and stay hidden until its snapshot applies", async () => {
    const fresh = deferred<Response>();
    mount();
    await menuAction("one", "Move to Trash");
    await menuAction("two", "Move to Trash");
    await Bun.sleep(MAIL_ROW_LEAVE_MS + 20);
    expect(rowIds()).toEqual(["three"]);
    const observedRows: (string | undefined)[][] = [];
    const observer = new MutationObserver(() => {
      observedRows.push(rowIds());
    });
    observer.observe(dom.root, { subtree: true, childList: true });
    try {
      workspaceResponse = () => fresh.promise;
      outcomeState = "confirmed";
      await Bun.sleep(1_050);
      expect(workspaceRequests).toHaveLength(1);
      expect(rowIds()).toEqual(["three"]);
      fresh.resolve(Response.json({ ...snapshot, listItems: [mailTestRow("three")] }));
      await settle();
      expect(workspaceRequests).toHaveLength(1);
      expect(rowIds()).toEqual(["three"]);
      expect(observedRows.every((ids) => !ids.includes("one") && !ids.includes("two"))).toBe(true);
    } finally {
      observer.disconnect();
    }
  });
  test("a message row removes only its message and focuses the next message of the same conversation", async () => {
    const hold = deferred<Response>();
    actionResponse = () => hold.promise;
    mount({
      listMode: "messages",
      listItems: ["Msg001", "Msg002", "Msg003"].map((id) => ({ ...mailTestRow(id), conversationId: "one", selectionKind: "message" })),
    });
    row("Msg001")!.querySelector<HTMLElement>(".mail-list-row")!.focus();
    await menuAction("Msg001", "Move to Trash");
    expect(dom.document.activeElement).toBe(row("Msg002")?.querySelector(".mail-list-row") ?? null);
    await Bun.sleep(MAIL_ROW_LEAVE_MS + 20);
    expect(rowIds()).toEqual(["Msg002", "Msg003"]);
    expect(requests[0]?.body.messageIds).toEqual(["Msg001"]);
    expect(toastAction("Undo").closest(".k2b-toast")?.textContent).toContain("Message moved to Trash");
    toastAction("Undo").click();
    expect(rowIds()).toEqual(["Msg001", "Msg002", "Msg003"]);
    hold.resolve(Response.json({ commands: [{ id: commandId(1), state: "queued" }] }));
    await settle();
  });
  test("sidebar drag uses the same projection and queue without a folder picker", async () => {
    const hold = deferred<Response>();
    actionResponse = () => hold.promise;
    mount({ folders: [...snapshot.folders, mailTestFolder("Filed1", { role: "folder", providerRole: "folder", name: "Filed" })] });
    const destination = dom.root.querySelector<HTMLElement>(`a[href="/app/mail/${MAILBOX_ID}?folder=Filed1"]`)!;
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { getData: () => JSON.stringify({ itemId: "two" }) } });
    destination.dispatchEvent(event);
    expect(row("two")?.dataset.leaving).toBe("true");
    expect(toastAction("Undo")).toBeDefined();
    await settle();
    expect(requests[0]?.body.kind).toBe("move_to_folder");
    hold.resolve(Response.json({ commands: [{ id: commandId(1), state: "queued" }] }));
    await settle();
  });
  test("reader Delete closes immediately and focuses the list, and Undo does not reopen the reader", async () => {
    const hold = deferred<Response>();
    actionResponse = () => hold.promise;
    mount({
      selectedConversationId: "one",
      selectedSubject: "one",
      detailMessages: [readerMessage],
      listItems: data.listItems.map((item) => ({ ...item, unread: false, unreadFolderIds: [] })),
    });
    const button = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Move to Trash"]');
    if (!button) throw new Error("No reader Delete");
    button.click();
    expect(row("one")?.dataset.leaving).toBe("true");
    expect(dom.root.querySelector("[data-mail-reader-heading]")).toBeNull();
    expect(dom.document.activeElement).toBe(row("two")?.querySelector(".mail-list-row") ?? null);
    toastAction("Undo").click();
    expect(rowIds()).toEqual(["one", "two", "three"]);
    await settle();
    expect(dom.root.querySelector("[data-mail-reader-heading]")).toBeNull();
    hold.resolve(Response.json({ commands: [{ id: commandId(1), state: "queued" }] }));
    await settle();
  });
  test("silent auto-read uses the projection and queue without a toast", async () => {
    const hold = deferred<Response>();
    actionResponse = () => hold.promise;
    mount({ selectedConversationId: "one", selectedSubject: "one", detailMessages: [{ ...readerMessage, flags: [] }] });
    expect(row("one")?.classList.contains("mail-list-entry-unread")).toBe(false);
    expect(badge(`/app/mail/${MAILBOX_ID}?folder=Inbox1`)).toContain("2");
    await settle();
    expect(requests[0]?.body.kind).toBe("change_state");
    expect(dom.document.querySelector(".k2b-toast")).toBeNull();
    hold.resolve(Response.json({ commands: [{ id: commandId(1), state: "queued" }] }));
    await settle();
  });
  test("an older toggle failure does not clear a later choice queued for the same conversation", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    actionResponse = (index) => (index === 1 ? first.promise : second.promise);
    mount();
    await menuAction("one", "Flag");
    await menuAction("one", "Remove flag");
    first.resolve(Response.json({ error: { message: "Rejected" } }, { status: 500 }));
    await settle();
    expect(requests).toHaveLength(2);
    expect(row("one")?.querySelector('[aria-label="Flagged conversation"]')).toBeNull();
    second.resolve(Response.json({ commands: [{ id: commandId(2), state: "queued" }] }));
    await settle();
    expect(row("one")?.querySelector('[aria-label="Flagged conversation"]')).toBeNull();
  });
  test("reduced motion hides in the click task without a leaving phase", async () => {
    dom.window.happyDOM.setViewport({ width: 1280, height: 800 });
    const matchMedia = dom.window.matchMedia.bind(dom.window);
    dom.window.matchMedia = (query) => {
      const media = matchMedia(query);
      if (query === "(prefers-reduced-motion: reduce)") Object.defineProperty(media, "matches", { value: true });
      return media;
    };
    mount();
    await menuAction("one", "Move to Trash");
    expect(row("one")).toBeNull();
    expect(dom.root.querySelector('[data-leaving="true"]')).toBeNull();
  });
});

pinClockBeforeEach(() => setSystemTime(new Date("2026-10-14T10:00:00.000Z")));
restoreClockAfterEach(() => setSystemTime());
