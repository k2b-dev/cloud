import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { DEFAULT_MAIL_CONTACT_DIRECTORY } from "../contact-directory-settings";
import type { MailFocusPage, MailFocusView } from "../contracts";

const focusItem = (id: string, subject: string): MailFocusPage["items"][number] => ({
  id,
  mailboxId: "Mail01",
  mailboxName: "Support",
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

/** Answers Focus requests only when the test lets them through, so it can look at the page in between. */
const heldFocusRequests = () => {
  const requests: { url: URL; respond: (page: Omit<MailFocusPage, "mailboxCounts">) => void }[] = [];
  const fetch = async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
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
  fetch: (input: RequestInfo | URL) => Promise<Response>;
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
        mailboxes: [],
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
  return {
    tab,
    text,
    skeleton,
    busy,
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

    // A view the server rendered empty is a finished read: its empty state shows at once.
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
