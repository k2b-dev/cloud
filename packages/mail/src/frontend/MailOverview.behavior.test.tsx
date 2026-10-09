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

test.skipIf(isServer)("pinning saves for the person and puts the row back when the save fails", async () => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.setURL("http://localhost/app/mail");
  const originalFetch = globalThis.fetch;
  const saves: { path: string; body: unknown }[] = [];
  let failSave = false;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (init?.method !== "PATCH" || !url.pathname.endsWith("/preference")) {
        return Response.json({ message: "Unexpected request" }, { status: 500 });
      }
      saves.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      if (failSave) return Response.json({ message: "Mail is restarting" }, { status: 503 });
      return Response.json({ pinned: true, hidden: false });
    },
    { preconnect: originalFetch.preconnect },
  );
  const { default: MailOverview } = await import("./MailOverview.island");
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
    accessScope: "mailbox" as const,
    composeSafety: { internalDomains: ["example.test"], largeRecipientThreshold: 20 },
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    permission: "admin" as const,
    receivingAddress: `${name.toLowerCase()}@example.test`,
  });
  const dispose = render(
    () =>
      createComponent(MailOverview, {
        mailboxes: [mailbox("Mail01", "Support"), mailbox("Mail02", "Sales"), mailbox("Mail03", "Billing")],
        initialView: "mine",
        initialSelection: null,
        initialDetail: null,
        initialPinnedMailboxIds: ["Mail02", "Mail03"],
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
  const order = () => Array.from(dom.root.querySelectorAll(".mail-overview-mailbox")).map((row) => row.getAttribute("data-mailbox"));
  try {
    await settle();
    // Pins come from the server in the order the person pinned them, newest first.
    expect(order()).toEqual(["Mail02", "Mail03", "Mail01"]);

    button("Pin Support").click();
    expect(order()).toEqual(["Mail01", "Mail02", "Mail03"]);
    await settle();
    expect(saves).toEqual([{ path: "/api/mail/mailboxes/Mail01/preference", body: { pinned: true } }]);

    // A failed save puts the row back where it was and says why.
    failSave = true;
    button("Unpin Sales").click();
    expect(order()).toEqual(["Mail01", "Mail03", "Mail02"]);
    await settle();
    expect(saves.at(-1)).toEqual({ path: "/api/mail/mailboxes/Mail02/preference", body: { pinned: false } });
    expect(order()).toEqual(["Mail01", "Mail02", "Mail03"]);
    button("Unpin Sales");
    expect(document.body.textContent).toContain("Mail is restarting");

    // Two quick changes that both fail end where the server is, not at the first change.
    button("Unpin Sales").click();
    button("Pin Sales").click();
    await settle();
    expect(saves.slice(-2).map((save) => save.body)).toEqual([{ pinned: false }, { pinned: true }]);
    expect(order()).toEqual(["Mail01", "Mail02", "Mail03"]);
    // The browser keeps no copy of its own.
    expect(document.cookie).not.toContain("pinnedMailboxIds");
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
  const saves: { mailboxId: string | undefined; body: unknown }[] = [];
  const focusItem = (id: string, mailboxId: string, subject: string) => ({
    id,
    mailboxId,
    mailboxName: mailboxId === "Mail01" ? "Support" : "Notifications",
    subject,
    participantSummary: "Ada",
    latestMessageAt: "2026-08-19T10:00:00.000Z",
    workStatus: "needs_action" as const,
    assigneeUserIds: [],
    unread: false,
    flagged: false,
    hasAttachments: false,
    preview: null,
  });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (init?.method === "PATCH" && url.pathname.endsWith("/preference")) {
        const body = JSON.parse(String(init.body)) as { hidden?: boolean; pinned?: boolean };
        saves.push({ mailboxId: url.pathname.split("/").at(-2), body });
        return Response.json({ pinned: body.pinned ?? false, hidden: body.hidden ?? false });
      }
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
  const { default: MailOverview } = await import("./MailOverview.island");
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
    accessScope: "mailbox" as const,
    composeSafety: { internalDomains: ["example.test"], largeRecipientThreshold: 20 },
    createdAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    permission: "admin" as const,
    receivingAddress: `${name.toLowerCase()}@example.test`,
  });
  // Gone01 was hidden before it left the listed mailboxes; Focus still leaves it out, as on the server.
  const dispose = render(
    () =>
      createComponent(MailOverview, {
        mailboxes: [mailbox("Mail01", "Support"), mailbox("Mail02", "Notifications")],
        initialView: "unassigned",
        initialSelection: null,
        initialDetail: null,
        initialPinnedMailboxIds: ["Mail02"],
        initialHiddenMailboxIds: ["Gone01"],
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
  const rowLink = (mailboxId: string) => dom.root.querySelector(`.mail-overview-mailbox[data-mailbox="${mailboxId}"] a`);
  // A keyboard user activates the button that has focus.
  const press = (label: string) => {
    const element = button(label);
    element.focus();
    element.click();
  };
  const scope = () => dom.root.querySelector(".mail-overview-scope")?.textContent;
  try {
    await settle();
    expect(requests).toHaveLength(0);
    expect(sectionToggle()).toBeNull();
    expect(scope()).toBe("All mailboxes");

    press("Hide Notifications");
    // Its rows leave Focus at once; the refreshed page brings counts without it.
    expect(dom.root.textContent).not.toContain("Automatic notice");
    expect(dom.root.textContent).toContain("Refund request");
    expect(scope()).toBe("All mailboxes except 1 hidden");
    // Focus moves to the row that took its place and stays there when the refreshed page arrives.
    expect(document.activeElement).toBe(rowLink("Mail01"));
    await settle();
    expect(document.activeElement).toBe(rowLink("Mail01"));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.searchParams.get("view")).toBe("unassigned");
    expect(requests[0]!.searchParams.get("excludeMailboxIds")).toBe("Mail02,Gone01");
    expect(dom.root.textContent).toContain("1 conversation without an assignee · All mailboxes except 1 hidden");
    expect(saves).toEqual([{ mailboxId: "Mail02", body: { hidden: true } }]);

    // The Hidden section starts collapsed and reveals the mailbox with its counts.
    expect(sectionToggle()?.textContent).toBe("Hidden1");
    expect(sectionToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(hiddenRows()).toHaveLength(1);
    expect(hiddenRows()[0]!.closest("[hidden]")).not.toBeNull();
    sectionToggle()!.click();
    await settle();
    expect(hiddenRows()[0]!.closest("[hidden]")).toBeNull();
    expect(hiddenRows()[0]!.getAttribute("title")).toContain("4 unread");

    press("Show Notifications");
    // Focus follows the mailbox back into the list.
    expect(document.activeElement).toBe(rowLink("Mail02"));
    await settle();
    expect(document.activeElement).toBe(rowLink("Mail02"));
    expect(rowLink("Mail02")?.closest("[data-hidden]")).toBeNull();
    expect(sectionToggle()).toBeNull();
    expect(scope()).toBe("All mailboxes");
    expect(saves.at(-1)).toEqual({ mailboxId: "Mail02", body: { hidden: false } });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.searchParams.get("excludeMailboxIds")).toBe("Gone01");
    // Pinned again at the top, as before hiding it.
    expect(dom.root.querySelector(".mail-overview-mailbox")?.getAttribute("data-pinned")).toBe("true");

    // Pinning moves Support above Notifications, and focus stays with it. Browsers drop focus from
    // a moved row, then focus lands on its link; this DOM keeps it on the button.
    press("Pin Support");
    expect(dom.root.querySelector(".mail-overview-mailbox")?.getAttribute("data-mailbox")).toBe("Mail01");
    expect(rowLink("Mail01")?.parentElement?.contains(document.activeElement)).toBe(true);

    // Hiding the last row focuses the row above; hiding the only one left focuses the Hidden section.
    press("Hide Notifications");
    expect(document.activeElement).toBe(rowLink("Mail01"));
    press("Hide Support");
    expect(document.activeElement).toBe(sectionToggle());
    await settle();
    expect(document.activeElement).toBe(sectionToggle());
    expect(scope()).toBe("All mailboxes except 2 hidden");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

test.skipIf(isServer)("a full hidden list keeps the mailbox in place and says why", async () => {
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
  const { default: MailOverview } = await import("./MailOverview.island");
  delegateEvents(["click"], dom.document);
  const dispose = render(
    () =>
      createComponent(MailOverview, {
        mailboxes: [
          {
            id: "Mail01",
            name: "Support",
            description: null,
            health: "active" as const,
            healthReason: null,
            syncEnabled: true,
            searchBackend: "auto" as const,
            automaticReplyManagementPermission: "admin" as const,
            accessScope: "mailbox" as const,
            composeSafety: { internalDomains: ["example.test"], largeRecipientThreshold: 20 },
            createdAt: "2026-08-19T10:00:00.000Z",
            updatedAt: "2026-08-19T10:00:00.000Z",
            permission: "admin" as const,
            receivingAddress: "support@example.test",
          },
        ],
        initialView: "mine",
        initialSelection: null,
        initialDetail: null,
        initialPinnedMailboxIds: [],
        // Hidden mailboxes beyond the ones the overview lists still count.
        initialHiddenMailboxIds: Array.from({ length: 200 }, (_, index) => `Hid${String(index).padStart(3, "0")}`),
        currentUserEmail: null,
        contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
        dateConfig: { locale: "en", timeZone: "UTC" },
        initialFocusError: null,
        initialFocus: { items: [], counts: { mine: 0, unassigned: 0, waiting: 0, all: 0 }, mailboxCounts: [], nextCursor: null },
      }),
    dom.root,
  );
  try {
    await Bun.sleep(30);
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Hide Support"]')!.click();
    await Bun.sleep(30);
    expect(document.body.textContent).toContain("You can hide at most 200 mailboxes. Show another one again first.");
    expect(dom.root.querySelector('.mail-overview-mailbox[data-mailbox="Mail01"]')?.getAttribute("data-hidden")).toBeNull();
    // Neither a save nor a Focus refresh past the 200 IDs Focus accepts.
    expect(requests).toEqual([]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
