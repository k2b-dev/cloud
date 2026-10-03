import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";

test.skipIf(isServer)("deleted mailboxes load on disclosure, retry failures, and paginate", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let fail = true;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (!url.includes("/mailboxes/deleted")) throw new Error(`Unexpected request: ${url}`);
      if (fail) return Response.json({ message: "Temporarily unavailable" }, { status: 503 });
      return Response.json({ items: [], nextCursor: url.includes("cursor=") ? null : "next" });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: MailOverview } = await import("./MailOverview.island");
  const dispose = render(
    () =>
      createComponent(MailOverview, {
        mailboxes: [],
        initialView: "mine",
        initialSelection: null,
        initialDetail: null,
        initialPinnedMailboxIds: [],
        initialHiddenMailboxIds: [],
        currentUserEmail: null,
        contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
        dateConfig: { locale: "en", timeZone: "UTC" },
        initialFocusError: null,
        initialFocus: { items: [], counts: { mine: 0, unassigned: 0, waiting: 0, all: 0 }, mailboxCounts: [], nextCursor: null },
      }),
    dom.root,
  );
  const settle = () => Bun.sleep(30);
  const button = (text: string) => {
    const element = Array.from(dom.root.querySelectorAll("button")).find((item) => item.textContent?.trim() === text);
    expect(element).toBeDefined();
    return element!;
  };
  try {
    await settle();
    expect(requests).toHaveLength(0);
    button("Recently deleted mailboxes").click();
    await settle();
    expect(requests).toHaveLength(1);
    expect(dom.root.textContent).toContain("Temporarily unavailable");
    fail = false;
    button("Retry").click();
    await settle();
    expect(requests).toHaveLength(2);
    button("Load more").click();
    await settle();
    expect(requests[2]).toContain("cursor=next");
    expect(dom.root.textContent).toContain("No deleted mailboxes");
    button("Recently deleted mailboxes").click();
    await settle();
    expect(dom.root.querySelector("#mail-deleted-mailboxes")).toBeNull();
    expect(requests).toHaveLength(3);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test.skipIf(isServer)("pinning from an older overview keeps pins a newer document saved", async () => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.setURL("http://localhost/app/mail");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ message: "Unexpected request" }, { status: 500 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const [{ default: MailOverview }, { readMailWorkspacePreferences }] = await Promise.all([
    import("./MailOverview.island"),
    import("./_components/mail-workspace-preferences"),
  ]);
  delegateEvents(["click"], dom.document);
  const mailbox = (id: string, name: string) => ({
    id,
    name,
    description: null,
    health: "active" as const,
    healthReason: null,
    syncEnabled: true,
    searchBackend: "auto" as const,
    automaticReplyManagementPermission: "admin" as const,
    composeSafety: { internalDomains: ["example.test"], largeRecipientThreshold: 20 },
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    permission: "admin" as const,
    receivingAddress: `${name.toLowerCase()}@example.test`,
  });
  const storeCookie = (preferences: object) => {
    document.cookie = `cloud_mail_workspace=${encodeURIComponent(JSON.stringify(preferences))}; Path=/app/mail`;
  };
  // A newer document pinned Sales after this overview rendered without pins.
  storeCookie({ listMode: "messages", pinnedMailboxIds: ["Mail02"] });
  const dispose = render(
    () =>
      createComponent(MailOverview, {
        mailboxes: [mailbox("Mail01", "Support"), mailbox("Mail02", "Sales")],
        initialView: "mine",
        initialSelection: null,
        initialDetail: null,
        initialPinnedMailboxIds: [],
        initialHiddenMailboxIds: [],
        currentUserEmail: null,
        contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
        dateConfig: { locale: "en", timeZone: "UTC" },
        initialFocusError: null,
        initialFocus: { items: [], counts: { mine: 0, unassigned: 0, waiting: 0, all: 0 }, mailboxCounts: [], nextCursor: null },
      }),
    dom.root,
  );
  const settle = () => Bun.sleep(30);
  const button = (label: string) => {
    const element = dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(element).not.toBeNull();
    return element!;
  };
  try {
    await settle();
    button("Pin Support").click();
    await settle();
    expect(readMailWorkspacePreferences(document.cookie)).toMatchObject({ listMode: "messages", pinnedMailboxIds: ["Mail01", "Mail02"] });
    button("Unpin Sales");

    // Another tab unpinned Sales; this overview still shows it pinned.
    storeCookie({ listMode: "messages", pinnedMailboxIds: ["Mail01"] });
    button("Unpin Sales").click();
    await settle();
    expect(readMailWorkspacePreferences(document.cookie).pinnedMailboxIds).toEqual(["Mail01"]);
    button("Pin Sales");
    expect(requests).toHaveLength(0);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test.skipIf(isServer)("hiding a mailbox moves it under Hidden and refreshes Focus without it", async () => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.setURL("http://localhost/app/mail");
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  const focusItem = (id: string, mailboxId: string, subject: string) => ({
    id,
    mailboxId,
    mailboxName: mailboxId === "Mail01" ? "Support" : "Notifications",
    subject,
    participantSummary: "Ada",
    latestMessageAt: "2026-08-19T10:00:00.000Z",
    workStatus: "needs_action" as const,
    assigneeUserId: null,
    unread: false,
    flagged: false,
    hasAttachments: false,
    preview: null,
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      requests.push(url);
      if (!url.pathname.endsWith("/overview/conversations")) return Response.json({ message: "Unexpected request" }, { status: 500 });
      const excluded = url.searchParams.get("excludeMailboxIds");
      return Response.json({
        items: excluded ? [focusItem("Convo1", "Mail01", "Refund request")] : [],
        counts: { mine: 0, unassigned: excluded ? 1 : 2, waiting: 0, all: excluded ? 1 : 2 },
        // Per-mailbox counts still cover hidden mailboxes.
        mailboxCounts: [{ mailboxId: "Mail02", unread: 4, needsAction: 1 }],
        nextCursor: null,
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  const [{ default: MailOverview }, { readMailWorkspacePreferences }] = await Promise.all([
    import("./MailOverview.island"),
    import("./_components/mail-workspace-preferences"),
  ]);
  delegateEvents(["click"], dom.document);
  const mailbox = (id: string, name: string) => ({
    id,
    name,
    description: null,
    health: "active" as const,
    healthReason: null,
    syncEnabled: true,
    searchBackend: "auto" as const,
    automaticReplyManagementPermission: "admin" as const,
    composeSafety: { internalDomains: ["example.test"], largeRecipientThreshold: 20 },
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    permission: "admin" as const,
    receivingAddress: `${name.toLowerCase()}@example.test`,
  });
  document.cookie = `cloud_mail_workspace=${encodeURIComponent(JSON.stringify({ pinnedMailboxIds: ["Mail02"] }))}; Path=/app/mail`;
  const dispose = render(
    () =>
      createComponent(MailOverview, {
        mailboxes: [mailbox("Mail01", "Support"), mailbox("Mail02", "Notifications")],
        initialView: "unassigned",
        initialSelection: null,
        initialDetail: null,
        initialPinnedMailboxIds: ["Mail02"],
        initialHiddenMailboxIds: [],
        currentUserEmail: null,
        contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
        dateConfig: { locale: "en", timeZone: "UTC" },
        initialFocusError: null,
        initialFocus: {
          items: [focusItem("Convo1", "Mail01", "Refund request"), focusItem("Convo2", "Mail02", "Automatic notice")],
          counts: { mine: 0, unassigned: 2, waiting: 0, all: 2 },
          mailboxCounts: [{ mailboxId: "Mail02", unread: 4, needsAction: 1 }],
          nextCursor: null,
        },
      }),
    dom.root,
  );
  const settle = () => Bun.sleep(30);
  const button = (label: string) => {
    const element = dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(element).not.toBeNull();
    return element!;
  };
  const sectionToggle = () => dom.root.querySelector<HTMLButtonElement>(".k2b-app-workspace__sidebar-section-toggle");
  const hiddenRows = () => dom.root.querySelectorAll('.mail-overview-mailbox[data-hidden="true"]');
  try {
    await settle();
    expect(requests).toHaveLength(0);
    expect(sectionToggle()).toBeNull();

    button("Hide Notifications").click();
    // Its rows leave Focus at once; the refreshed page brings counts without it.
    expect(dom.root.textContent).not.toContain("Automatic notice");
    expect(dom.root.textContent).toContain("Refund request");
    await settle();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("view")).toBe("unassigned");
    expect(requests[0]!.searchParams.get("excludeMailboxIds")).toBe("Mail02");
    expect(dom.root.textContent).toContain("1 conversation without an assignee");
    expect(readMailWorkspacePreferences(document.cookie)).toMatchObject({ pinnedMailboxIds: ["Mail02"], hiddenMailboxIds: ["Mail02"] });

    // The Hidden section starts collapsed and reveals the mailbox with its counts.
    expect(sectionToggle()?.textContent).toBe("Hidden1");
    expect(sectionToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(hiddenRows()).toHaveLength(1);
    expect(hiddenRows()[0]!.closest("[hidden]")).not.toBeNull();
    sectionToggle()!.click();
    await settle();
    expect(hiddenRows()[0]!.closest("[hidden]")).toBeNull();
    expect(hiddenRows()[0]!.getAttribute("title")).toContain("4 unread");

    button("Show Notifications").click();
    await settle();
    expect(sectionToggle()).toBeNull();
    expect(readMailWorkspacePreferences(document.cookie).hiddenMailboxIds).toEqual([]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.searchParams.has("excludeMailboxIds")).toBe(false);
    // Pinned again at the top, as before hiding it.
    expect(dom.root.querySelector(".mail-overview-mailbox")?.getAttribute("data-pinned")).toBe("true");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
