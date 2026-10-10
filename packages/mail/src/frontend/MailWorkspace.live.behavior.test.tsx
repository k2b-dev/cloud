import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { MailboxPageData } from "../service/workspace";

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
  permission: "read",
  access: { scope: "mailbox", permission: "read" },
  initialLiveCursor: "s6t.mail.4",
  folders: [],
  identities: [],
  scheduledMode: false,
  scheduledCount: 0,
  scheduledPage: null,
  scheduledError: null,
  draftsMode: false,
  draftsPage: null,
  draftsError: null,
  activeView: "needs_action",
  savedViewId: null,
  savedViews: [],
  listMode: "conversations",
  folderId: null,
  viewCounts: { needs_action: 0, mine: 0, unassigned: 0, waiting: 0, done: 0, snoozed: 0, send_problems: 0, recently_active: 0, kept: 0 },
  query: "",
  selectedConversationId: null,
  selectedMessageId: null,
  listItems: [],
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

/** Long enough for a refresh through the mocked API to finish. */
const settle = () => Bun.sleep(60);

describe("Mail workspace live updates", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let dom: DomTestHarness;
  let visibility: DocumentVisibilityState;
  let reload: ReturnType<typeof spyOn>;
  let workspaceRequests: number;
  let listRequests: number;
  let dispose = () => {};

  beforeEach(() => {
    dom = createDomTestHarness();
    dom.window.sessionStorage.clear();
    reload = spyOn(dom.window.location, "reload").mockImplementation(() => {});
    visibility = "visible";
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    workspaceRequests = 0;
    listRequests = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/workspace-route")) {
          workspaceRequests += 1;
          return Response.json(data);
        }
        if (url.includes("/subscriptions")) {
          listRequests += 1;
          return Response.json({ items: [], nextCursor: null });
        }
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
  });

  afterEach(async () => {
    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    dispose();
    await Bun.sleep(20);
    reload.mockRestore();
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    dom.cleanup();
  });

  const mount = async (path = `/app/mail/${MAILBOX_ID}`) => {
    const {
      readThemeFromCookieHeader,
      DEFAULT_MAIL_CONTACT_DIRECTORY,
      readMailUserPreferencesFromCookieHeader,
      readMailWorkspacePreferences,
      MailWorkspace,
    } = modules!;
    dom.window.history.replaceState(null, "", path);
    dispose = render(
      () =>
        createComponent(MailWorkspace, {
          data,
          requestPath: path,
          currentUserId: "user-1",
          currentUserEmail: "reader@example.test",
          contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
          dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
          initialPreferences: readMailWorkspacePreferences(""),
          initialUserPreferences: readMailUserPreferencesFromCookieHeader("", MAILBOX_ID),
          initialTheme: readThemeFromCookieHeader(""),
          calendarIntegrationAvailable: false,
        }),
      dom.root,
    );
  };

  const socket = () => {
    const latest = FakeWebSocket.instances.at(-1);
    if (!latest) throw new Error("No socket was opened");
    return latest;
  };

  const returnToTab = () => {
    visibility = "hidden";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    expect(socket().readyState).toBe(FakeWebSocket.CLOSED);
    visibility = "visible";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    socket().open();
  };

  const event = (id: string, cursor: string, conversationId: string | null) =>
    socket().message({ t: "event", id, cursor, data: { conversationId } });

  const updatesPaused = () => dom.root.textContent?.includes("Updates paused") ?? false;

  test("changes refresh the view, and a returning tab resumes from its cursor without loading again", async () => {
    await mount();
    socket().open();
    expect(socket().url).toBe("ws://localhost/api/mail/live");
    expect(socket().sent).toEqual([{ t: "sub", id: "1", channel: "mailbox", scope: { mailbox: MAILBOX_ID }, after: "s6t.mail.4" }]);
    socket().message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    await settle();
    expect(workspaceRequests).toBe(0);

    event("1", "s6t.mail.5", "Conv01");
    await settle();
    expect(workspaceRequests).toBe(1);

    // Hidden, the tab misses one change; it arrives as a replay after the applied cursor, and nothing else loads.
    returnToTab();
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(socket().sent).toEqual([{ t: "sub", id: "1", channel: "mailbox", scope: { mailbox: MAILBOX_ID }, after: "s6t.mail.5" }]);
    socket().message({ t: "ready", id: "1", cursor: "s6t.mail.5" });
    await settle();
    expect(workspaceRequests).toBe(1);
    event("1", "s6t.mail.6", null);
    await settle();
    expect(workspaceRequests).toBe(2);

    // A cursor the server can no longer replay from loads the view once.
    socket().message({ t: "resync", id: "1", cursor: "s6t.mail.90" });
    await settle();
    expect(workspaceRequests).toBe(3);
    expect(reload).not.toHaveBeenCalled();
  });

  test("the subscription dialog shares the page's socket, and the view catches up once the dialog closes", async () => {
    await mount(`/app/mail/${MAILBOX_ID}?mailingList=news%40example.test`);
    await settle();
    socket().open();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const subscriptions = socket().sent.filter((frame) => frame.t === "sub");
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions.every((frame) => frame.channel === "mailbox")).toBe(true);
    // The dialog resumes from the page's cursor too, which was read before its list loaded.
    expect(subscriptions.every((frame) => frame.after === "s6t.mail.4")).toBe(true);
    const ids = subscriptions.map((frame) => frame.id!);
    for (const id of ids) socket().message({ t: "ready", id, cursor: "s6t.mail.4" });
    await settle();
    expect(listRequests).toBe(1);

    // The dialog refreshes its list at once; the view behind it waits.
    for (const id of ids) event(id, "s6t.mail.5", "Conv01");
    await settle();
    expect({ listRequests, workspaceRequests }).toEqual({ listRequests: 2, workspaceRequests: 0 });

    const { dialogCore } = await import("@k2b/ui");
    dialogCore.close();
    await settle();
    expect(workspaceRequests).toBe(1);
    const closed = socket().sent.at(-1);
    expect(closed?.t).toBe("unsub");
    expect(ids).toContain(closed?.id ?? "");
  });

  test("an ended session reloads the page once, and a page that just reloaded shows that updates are paused", async () => {
    await mount();
    socket().open();
    socket().message({ t: "ready", id: "1", cursor: "s6t.mail.4" });
    socket().message({ t: "error", code: "login_required", message: "Sign in again to receive live updates." });
    socket().close(1008, "login_required");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(updatesPaused()).toBe(false);

    dispose();
    await mount();
    socket().open();
    socket().close(1008, "login_required");
    await settle();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(updatesPaused()).toBe(true);
  });
});
