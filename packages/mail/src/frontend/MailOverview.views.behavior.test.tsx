import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";
import type { MailFocusPage, MailFocusView } from "../contracts";

const focusItem = (id: string, subject: string, mailboxId = "Mail01"): MailFocusPage["items"][number] => ({
  id,
  mailboxId,
  mailboxName: mailboxId === "Mail01" ? "Support" : "Notifications",
  subject,
  participantSummary: "Ada",
  latestMessageAt: "2026-08-19T10:00:00.000Z",
  workStatus: "needs_action",
  assigneeUserIds: [],
  unread: false,
  flagged: false,
  hasAttachments: false,
  preview: null,
});

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

/**
 * Answers Focus requests only when the test lets them through, so it can look at the page in between.
 * Like a response that arrived just before its request was cancelled, a held one still answers then.
 * Mailbox preferences save at once.
 */
const heldFocusRequests = () => {
  const requests: { url: URL; respond: (page: Omit<MailFocusPage, "mailboxCounts">) => void }[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (init?.method === "PATCH" && url.pathname.endsWith("/preference")) {
      const body = JSON.parse(String(init.body)) as { hidden?: boolean; pinned?: boolean };
      return Response.json({ pinned: body.pinned ?? false, hidden: body.hidden ?? false });
    }
    if (!url.pathname.endsWith("/overview/conversations")) return Response.json({ message: "Unexpected request" }, { status: 500 });
    return new Promise<Response>((resolve) => {
      requests.push({ url, respond: (page) => resolve(Response.json({ ...page, mailboxCounts: [] })) });
    });
  };
  return { requests, fetch };
};

const mountOverview = async (props: {
  initialView: MailFocusView;
  initialFocus: Parameters<typeof import("./MailOverview.island").default>[0]["initialFocus"];
  initialFocusError: string | null;
  withMailboxes?: boolean;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}) => {
  const dom = createDomTestHarness();
  dom.window.happyDOM.setURL("http://localhost/app/mail");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(props.fetch, { preconnect: originalFetch.preconnect });
  const { default: MailOverview } = await import("./MailOverview.island");
  delegateEvents(["click"], dom.document);
  const dispose = render(
    () =>
      createComponent(MailOverview, {
        mailboxes: props.withMailboxes ? [mailbox("Mail01", "Support"), mailbox("Mail02", "Notifications")] : [],
        initialView: props.initialView,
        initialSelection: null,
        initialDetail: null,
        initialPinnedMailboxIds: [],
        initialHiddenMailboxIds: [],
        currentUserEmail: null,
        contactDirectory: DEFAULT_MAIL_CONTACT_DIRECTORY,
        dateConfig: { locale: "en", timeZone: "UTC" },
        initialFocusError: props.initialFocusError,
        initialFocus: props.initialFocus,
      }),
    dom.root,
  );
  const tab = (label: string) => {
    const element = Array.from(dom.root.querySelectorAll<HTMLElement>('[role="radio"]')).find((item) =>
      item.textContent?.startsWith(label),
    );
    expect(element).toBeDefined();
    return element!;
  };
  const text = () => dom.root.textContent ?? "";
  const skeleton = () => dom.root.querySelector(".mail-focus-skeleton");
  const busy = () => dom.root.querySelector(".mail-focus-main")?.getAttribute("aria-busy");
  const press = (label: string) => {
    const element = dom.root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(element).not.toBeNull();
    element!.click();
  };
  return {
    tab,
    text,
    skeleton,
    busy,
    press,
    cleanup: () => {
      dispose();
      globalThis.fetch = originalFetch;
      dom.cleanup();
    },
  };
};

const settle = () => Bun.sleep(30);

test.skipIf(isServer)("switching views shows the server's rows at once and refreshes them in place", async () => {
  const held = heldFocusRequests();
  const emptyPage = { items: [], nextCursor: null };
  const overview = await mountOverview({
    initialView: "mine",
    initialFocusError: null,
    initialFocus: {
      pages: {
        mine: emptyPage,
        unassigned: { items: [focusItem("Convo1", "Refund request"), focusItem("Convo2", "Invoice question")], nextCursor: null },
        waiting: emptyPage,
        all: emptyPage,
      },
      counts: { mine: 0, unassigned: 2, waiting: 0, all: 2 },
      mailboxCounts: [],
    },
    fetch: held.fetch,
  });
  try {
    await settle();
    expect(held.requests).toHaveLength(0);
    expect(overview.text()).toContain("Nothing assigned to you");

    overview.tab("Unassigned").click();
    // The rows the server rendered for the view show before any request answers.
    expect(overview.text()).toContain("Refund request");
    expect(overview.text()).not.toContain("No unassigned conversations");
    expect(overview.skeleton()).toBeNull();
    await settle();
    expect(held.requests).toHaveLength(1);
    expect(held.requests[0]!.url.searchParams.get("view")).toBe("unassigned");
    expect(overview.busy()).toBe("true");
    expect(overview.text()).toContain("Invoice question");

    held.requests[0]!.respond({
      items: [focusItem("Convo3", "New order"), focusItem("Convo1", "Refund request")],
      counts: { mine: 0, unassigned: 2, waiting: 0, all: 2 },
      nextCursor: null,
    });
    await settle();
    expect(overview.text()).toContain("New order");
    expect(overview.text()).not.toContain("Invoice question");
    expect(overview.busy()).toBe("false");

    // A view the server rendered empty, with a count that agrees, is a finished read: its empty state shows at once.
    overview.tab("For me").click();
    expect(overview.text()).toContain("Nothing assigned to you");
    expect(overview.skeleton()).toBeNull();
    await settle();
    expect(held.requests).toHaveLength(2);
    held.requests[1]!.respond({ items: [], counts: { mine: 0, unassigned: 2, waiting: 0, all: 2 }, nextCursor: null });
    await settle();

    // A visited view keeps its rows while it refreshes again.
    overview.tab("Unassigned").click();
    expect(overview.text()).toContain("New order");
    await settle();
    expect(held.requests).toHaveLength(3);
    held.requests[2]!.respond({
      items: [focusItem("Convo3", "New order")],
      counts: { mine: 0, unassigned: 1, waiting: 0, all: 1 },
      nextCursor: null,
    });
    await settle();
  } finally {
    overview.cleanup();
  }
});

test.skipIf(isServer)("a view without a finished read shows loading rows, never its empty state", async () => {
  const held = heldFocusRequests();
  const overview = await mountOverview({
    initialView: "mine",
    initialFocusError: "Mail is restarting",
    initialFocus: null,
    fetch: held.fetch,
  });
  try {
    await settle();
    // A failed server read shows the failure and asks nothing on its own.
    expect(overview.text()).toContain("Could not load focused mail");
    expect(held.requests).toHaveLength(0);

    overview.tab("Unassigned").click();
    await settle();
    expect(held.requests).toHaveLength(1);
    expect(overview.text()).not.toContain("No unassigned conversations");
    expect(overview.text()).not.toContain("Could not load focused mail");
    const skeleton = overview.skeleton();
    expect(skeleton?.getAttribute("role")).toBe("status");
    expect(skeleton?.getAttribute("aria-busy")).toBe("true");
    expect(skeleton?.textContent).toBe("Loading focused mail");
    // Without counts one loading row stands in a box of the empty state's height.
    expect(skeleton?.querySelectorAll('.mail-focus-row[aria-hidden="true"]')).toHaveLength(1);
    expect(skeleton?.classList.contains("min-h-56")).toBe(true);
    expect(overview.busy()).toBe("true");

    held.requests[0]!.respond({ items: [], counts: { mine: 0, unassigned: 0, waiting: 0, all: 3 }, nextCursor: null });
    await settle();
    expect(overview.skeleton()).toBeNull();
    expect(overview.text()).toContain("No unassigned conversations");

    // Counts known from that read size the loading rows of the next view.
    overview.tab("All active").click();
    await settle();
    expect(overview.skeleton()?.querySelectorAll(".mail-focus-row")).toHaveLength(3);
    expect(overview.skeleton()?.classList.contains("min-h-56")).toBe(false);
    expect(overview.text()).not.toContain("No active conversations");
    held.requests[1]!.respond({
      items: [focusItem("Convo1", "Refund request"), focusItem("Convo2", "Invoice question"), focusItem("Convo3", "New order")],
      counts: { mine: 0, unassigned: 0, waiting: 0, all: 3 },
      nextCursor: null,
    });
    await settle();
    expect(overview.skeleton()).toBeNull();
    expect(overview.text()).toContain("New order");
  } finally {
    overview.cleanup();
  }
});

test.skipIf(isServer)("an empty view whose count has grown since shows loading rows, not its empty state, while it refreshes", async () => {
  const held = heldFocusRequests();
  const emptyPage = { items: [], nextCursor: null };
  const overview = await mountOverview({
    initialView: "unassigned",
    initialFocusError: null,
    initialFocus: {
      pages: {
        mine: emptyPage,
        unassigned: { items: [focusItem("Convo1", "Refund request")], nextCursor: null },
        waiting: emptyPage,
        all: emptyPage,
      },
      counts: { mine: 0, unassigned: 1, waiting: 0, all: 1 },
      mailboxCounts: [],
    },
    fetch: held.fetch,
  });
  try {
    // Another view's read brings newer counts: the conversation is now assigned to the person.
    overview.tab("Waiting").click();
    await settle();
    held.requests[0]!.respond({ items: [], counts: { mine: 1, unassigned: 0, waiting: 0, all: 1 }, nextCursor: null });
    await settle();
    expect(overview.text()).toContain("No conversations waiting for a reply");
    expect(overview.tab("For me").textContent).toBe("For me 1");

    // For me still holds the server's empty page, but its count says 1.
    overview.tab("For me").click();
    expect(overview.text()).not.toContain("Nothing assigned to you");
    expect(overview.skeleton()?.querySelectorAll(".mail-focus-row")).toHaveLength(1);
    await settle();
    expect(held.requests).toHaveLength(2);
    expect(overview.text()).not.toContain("Nothing assigned to you");
    held.requests[1]!.respond({
      items: [focusItem("Convo1", "Refund request")],
      counts: { mine: 1, unassigned: 0, waiting: 0, all: 1 },
      nextCursor: null,
    });
    await settle();
    expect(overview.skeleton()).toBeNull();
    expect(overview.text()).toContain("Refund request");
  } finally {
    overview.cleanup();
  }
});

test.skipIf(isServer)("hiding or showing a mailbox shows loading rows, not the empty state, until the refreshed page arrives", async () => {
  const held = heldFocusRequests();
  const emptyPage = { items: [], nextCursor: null };
  const overview = await mountOverview({
    initialView: "unassigned",
    initialFocusError: null,
    withMailboxes: true,
    initialFocus: {
      pages: {
        mine: emptyPage,
        // Support supplies the whole first page; a Notifications conversation follows on the next one.
        unassigned: { items: [focusItem("Convo1", "Refund request"), focusItem("Convo2", "Invoice question")], nextCursor: "next" },
        waiting: emptyPage,
        all: emptyPage,
      },
      counts: { mine: 0, unassigned: 3, waiting: 0, all: 3 },
      mailboxCounts: [],
    },
    fetch: held.fetch,
  });
  try {
    overview.press("Hide Support");
    expect(overview.text()).not.toContain("Refund request");
    expect(overview.text()).not.toContain("No unassigned conversations");
    expect(overview.skeleton()).not.toBeNull();
    await settle();
    expect(held.requests).toHaveLength(1);
    expect(held.requests[0]!.url.searchParams.get("excludeMailboxIds")).toBe("Mail01");
    expect(overview.text()).not.toContain("No unassigned conversations");
    held.requests[0]!.respond({
      items: [focusItem("Convo3", "Delivery notice", "Mail02")],
      counts: { mine: 0, unassigned: 1, waiting: 0, all: 1 },
      nextCursor: null,
    });
    await settle();
    expect(overview.skeleton()).toBeNull();
    expect(overview.text()).toContain("Delivery notice");

    // Hiding Notifications too leaves nothing: the empty state shows once the read says so.
    overview.press("Hide Notifications");
    expect(overview.text()).not.toContain("No unassigned conversations");
    await settle();
    held.requests[1]!.respond({ items: [], counts: { mine: 0, unassigned: 0, waiting: 0, all: 0 }, nextCursor: null });
    await settle();
    expect(overview.skeleton()).toBeNull();
    expect(overview.text()).toContain("No unassigned conversations");

    // Showing a mailbox again can bring rows the empty view never had.
    overview.press("Show Notifications");
    expect(overview.text()).not.toContain("No unassigned conversations");
    expect(overview.skeleton()?.classList.contains("min-h-56")).toBe(true);
    await settle();
    expect(held.requests[2]!.url.searchParams.get("excludeMailboxIds")).toBe("Mail01");
    expect(overview.text()).not.toContain("No unassigned conversations");
    held.requests[2]!.respond({
      items: [focusItem("Convo3", "Delivery notice", "Mail02")],
      counts: { mine: 0, unassigned: 1, waiting: 0, all: 1 },
      nextCursor: null,
    });
    await settle();
    expect(overview.skeleton()).toBeNull();
    expect(overview.text()).toContain("Delivery notice");
  } finally {
    overview.cleanup();
  }
});

test.skipIf(isServer)("a response that arrives after its view was left does not change the counts", async () => {
  const held = heldFocusRequests();
  const emptyPage = { items: [], nextCursor: null };
  const counts = { mine: 1, unassigned: 2, waiting: 0, all: 3 };
  const overview = await mountOverview({
    initialView: "mine",
    initialFocusError: null,
    initialFocus: {
      pages: {
        mine: { items: [focusItem("Convo1", "Refund request")], nextCursor: null },
        unassigned: { items: [focusItem("Convo2", "Invoice question"), focusItem("Convo3", "New order")], nextCursor: null },
        waiting: emptyPage,
        all: {
          items: [focusItem("Convo1", "Refund request"), focusItem("Convo2", "Invoice question"), focusItem("Convo3", "New order")],
          nextCursor: null,
        },
      },
      counts,
      mailboxCounts: [],
    },
    fetch: held.fetch,
  });
  try {
    overview.tab("Unassigned").click();
    await settle();
    overview.tab("Waiting").click();
    await settle();
    expect(held.requests.map((request) => request.url.searchParams.get("view"))).toEqual(["unassigned", "waiting"]);
    held.requests[0]!.respond({ items: [], counts: { mine: 1, unassigned: 9, waiting: 0, all: 10 }, nextCursor: null });
    await settle();
    expect(overview.tab("Unassigned").textContent).toBe("Unassigned 2");
    expect(overview.tab("All active").textContent).toBe("All active 3");
    held.requests[1]!.respond({ items: [], counts: { mine: 1, unassigned: 1, waiting: 0, all: 2 }, nextCursor: null });
    await settle();
    expect(overview.tab("Unassigned").textContent).toBe("Unassigned 1");
  } finally {
    overview.cleanup();
  }
});
