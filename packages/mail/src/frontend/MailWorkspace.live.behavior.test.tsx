import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { MailboxPageData } from "../service/workspace";

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
    composeSafety: { internalDomains: [], largeRecipientThreshold: 20 },
    createdAt: now,
    updatedAt: now,
  },
  permission: "read",
  initialLiveCursor: "s6t.mail.4",
  folders: [],
  identities: [],
  scheduledMode: false,
  scheduledCount: 0,
  scheduledPage: null,
  scheduledError: null,
  activeView: "needs_action",
  savedViewId: null,
  savedViews: [],
  listMode: "conversations",
  folderId: null,
  viewCounts: { needs_action: 0, mine: 0, unassigned: 0, waiting: 0, done: 0, snoozed: 0, send_problems: 0, recently_active: 0 },
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
  collaborationError: null,
  detailErrors: {
    collaboration: null,
    tags: null,
    comments: null,
    assignableUsers: null,
    activity: null,
    reminder: null,
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
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(type: string, payload: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ type, payload: { mailboxId: MAILBOX_ID, ...payload } }) });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

/** Longer than the workspace's live refresh delay, so a scheduled refresh has run. */
const settle = () => Bun.sleep(400);

describe("Mail workspace live updates when a tab returns", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let dom: DomTestHarness;
  let visibility: DocumentVisibilityState;
  let workspaceRequests: number;
  let dispose = () => {};

  beforeEach(() => {
    dom = createDomTestHarness();
    visibility = "visible";
    Object.defineProperty(dom.document, "visibilityState", { configurable: true, get: () => visibility });
    FakeWebSocket.instances = [];
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    workspaceRequests = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/workspace-route")) {
          workspaceRequests += 1;
          return Response.json(data);
        }
        return Response.json({});
      },
      { preconnect: originalFetch.preconnect },
    );
  });

  afterEach(async () => {
    dispose();
    await Bun.sleep(20);
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    dom.cleanup();
  });

  const mount = async () => {
    // Browser modules load after the DOM harness exists.
    const { readThemeFromCookieHeader } = await import("@k2b/cloud/shared");
    const { DEFAULT_MAIL_CONTACT_DIRECTORY } = await import("../contact-directory-settings");
    const { readMailUserPreferencesFromCookieHeader } = await import("./_components/mail-user-preferences");
    const { readMailWorkspacePreferences } = await import("./_components/mail-workspace-preferences");
    const { default: MailWorkspace } = await import("./MailWorkspace.island");
    dispose = render(
      () =>
        createComponent(MailWorkspace, {
          data,
          requestPath: `/app/mail/${MAILBOX_ID}`,
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

  const latestSocket = () => {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) throw new Error("No socket was opened");
    return socket;
  };

  const returnToTab = () => {
    visibility = "hidden";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    visibility = "visible";
    dom.document.dispatchEvent(new dom.window.Event("visibilitychange") as unknown as Event);
    latestSocket().open();
  };

  const updatesPaused = () => dom.root.textContent?.includes("Updates paused") ?? false;

  test("a returning tab whose cursor did not move refreshes nothing", async () => {
    await mount();
    latestSocket().open();
    latestSocket().message("mail.live.ready", { cursor: "s6t.mail.4" });
    await settle();

    returnToTab();
    expect(FakeWebSocket.instances).toHaveLength(2);
    latestSocket().message("mail.live.ready", { cursor: "s6t.mail.4" });
    await settle();
    expect(workspaceRequests).toBe(0);
  });

  test("a stream error pauses updates until the reconnected stream confirms the page is current", async () => {
    await mount();
    latestSocket().open();
    latestSocket().message("mail.live.ready", { cursor: "s6t.mail.4" });
    await settle();

    // The server reports a failed access check and closes; the client reconnects from the same cursor.
    latestSocket().message("mail.live.error", { code: "internal_error", message: "Access check failed" });
    latestSocket().close(1011, "internal_error");
    expect(updatesPaused()).toBe(true);
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    latestSocket().open();
    latestSocket().message("mail.live.ready", { cursor: "s6t.mail.4" });
    await settle();

    expect(workspaceRequests).toBe(1);
    expect(updatesPaused()).toBe(false);
  });
});
