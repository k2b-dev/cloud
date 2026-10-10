import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "../../../ui/test/dom";
import type { MailFolderView } from "../service/messages";
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

const folder = (id: string, name: string, overrides: Partial<MailFolderView> = {}): MailFolderView => ({
  id,
  parentId: null,
  name,
  role: "other",
  providerRole: "other",
  configuredRole: null,
  selectable: true,
  display: "everywhere",
  effectiveDisplay: "everywhere",
  displayInheritedFromFolderId: null,
  displayNeutral: false,
  namespaceKinds: ["shared"],
  discoveryState: "active",
  missingSince: null,
  syncStatus: "current",
  total: 4,
  unread: 2,
  ...overrides,
});
const folders = [
  folder("Fold01", "Inbox", { role: "inbox", providerRole: "inbox", namespaceKinds: ["personal"] }),
  folder("Fold02", "Shared", { display: "folder_only", effectiveDisplay: "folder_only" }),
  folder("Fold03", "Projects", { parentId: "Fold02", effectiveDisplay: "folder_only", displayInheritedFromFolderId: "Fold02" }),
  folder("Fold04", "Newsletter", { display: "folder_only", effectiveDisplay: "folder_only", namespaceKinds: ["personal"] }),
];
const preferencesCookie = (dismissedFolderHints: string[]) =>
  `settings-app-mail=${encodeURIComponent(JSON.stringify({ mailboxes: { [MAILBOX_ID]: { dismissedFolderHints } } }))}`;

describe("Mail workspace hint for folders whose mail stays inside them", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  let dom: DomTestHarness;
  let dispose = () => {};

  beforeEach(() => {
    dom = createDomTestHarness();
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
    globalThis.fetch = Object.assign(async () => Response.json({}), { preconnect: originalFetch.preconnect });
  });

  afterEach(async () => {
    dispose();
    await Bun.sleep(20);
    globalThis.fetch = originalFetch;
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = originalWebSocket;
    dom.cleanup();
  });

  const mount = (overrides: Partial<MailboxPageData>, cookie = "") => {
    const {
      readThemeFromCookieHeader,
      DEFAULT_MAIL_CONTACT_DIRECTORY,
      readMailUserPreferencesFromCookieHeader,
      readMailWorkspacePreferences,
      MailWorkspace,
    } = modules!;
    if (cookie) dom.document.cookie = cookie;
    dispose = render(
      () =>
        createComponent(MailWorkspace, {
          data: { ...data, folders, ...overrides },
          requestPath: `/app/mail/${MAILBOX_ID}`,
          currentUserId: "user-1",
          currentUserEmail: "reader@example.test",
          contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
          dateConfig: { timeZone: "Europe/Berlin", locale: "en" },
          initialPreferences: readMailWorkspacePreferences(""),
          initialUserPreferences: readMailUserPreferencesFromCookieHeader(cookie, MAILBOX_ID),
          initialTheme: readThemeFromCookieHeader(""),
          calendarIntegrationAvailable: false,
        }),
      dom.root,
    );
  };
  const hint = () => dom.root.querySelector("[data-mail-folder-only-hint]");

  test("names the first such folder in a combined view and moves on to the next once dismissed", () => {
    mount({ activeView: "needs_action" });

    expect(hint()?.textContent).toContain("Mail from “Shared” now appears only in its folder.");
    expect(hint()?.querySelector("a")?.getAttribute("href")).toBe(`/app/mail/${MAILBOX_ID}?folder=Fold02`);

    hint()?.querySelector<HTMLButtonElement>('button[aria-label="Dismiss hint"]')?.click();

    expect(hint()?.textContent).toContain("Mail from “Newsletter” now appears only in its folder.");
    expect(decodeURIComponent(dom.document.cookie)).toContain('"dismissedFolderHints":["Fold02"]');
  });

  test("stays away from open folders, Assigned to me, and dismissed folders", () => {
    mount({ activeView: null, folderId: "Fold02" });
    expect(hint()).toBeNull();
    dispose();

    mount({ activeView: "mine" });
    expect(hint()).toBeNull();
    dispose();

    mount({ activeView: null }, preferencesCookie(["Fold02", "Fold04"]));
    expect(hint()).toBeNull();
  });
});
