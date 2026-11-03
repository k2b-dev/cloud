import { afterEach, expect, test } from "bun:test";
import { createComponent, createRoot } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import { EMPTY_MAIL_EVENTS_FILTER, type MailEventsFilter } from "../../mail-events-route";
import type { MailActivityEvent } from "../../service/collaboration";
import type { MailEventsPage } from "../../service/workspace";

const settle = async () => {
  await Promise.resolve();
  await Bun.sleep(30);
};

const ME = "11111111-1111-4111-8111-111111111111";
const MIRA = "22222222-2222-4222-8222-222222222222";
const today = new Date().toISOString();

const event = (id: string, overrides: Partial<MailActivityEvent> = {}): MailActivityEvent => ({
  id,
  conversationId: "Conv01",
  actor: { kind: "user", id: MIRA, displayName: "Mira Schulz", avatarHash: null },
  action: "conversation.comment_created",
  outcome: "confirmed",
  targetType: "comment",
  targetId: "Comm01",
  metadata: {},
  createdAt: today,
  conversationSubject: "Invoice 4711",
  assignees: null,
  ...overrides,
});

const page = (
  items: MailActivityEvent[],
  filter: MailEventsFilter = EMPTY_MAIL_EVENTS_FILTER,
  nextCursor: string | null = null,
): MailEventsPage => ({
  items,
  nextCursor,
  filter,
  people: [
    { id: ME, displayName: "Lea Brandt", avatarHash: null },
    { id: MIRA, displayName: "Mira Schulz", avatarHash: null },
  ],
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const renderFeed = async (input: { page: MailEventsPage | null; error?: string | null; loading?: boolean; filter?: MailEventsFilter }) => {
  const dom = createDomTestHarness();
  dom.document.documentElement.lang = "de";
  const [{ MailEventsFeed, createMailEventsFeed }, { LocaleProvider }] = await Promise.all([import("./MailEventsFeed"), import("@k2b/ui")]);
  const hrefs: string[] = [];
  const opened: Array<[string, string, string]> = [];
  let retries = 0;
  const { feed, disposeFeed } = createRoot((disposeFeed) => ({
    feed: createMailEventsFeed({ mailboxId: "Box001", page: () => input.page, failedMessage: () => "Failed" }),
    disposeFeed,
  }));
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "de",
        get children() {
          return createComponent(MailEventsFeed, {
            mailboxId: "Box001",
            feed,
            page: input.page,
            filter: input.filter ?? input.page?.filter ?? EMPTY_MAIL_EVENTS_FILTER,
            error: input.error ?? null,
            loading: input.loading ?? false,
            selectedConversationId: null,
            currentUserId: ME,
            dateConfig: { timeZone: "UTC", locale: "de" },
            localTags: [],
            onOpenHref: (href) => hrefs.push(href),
            onOpenConversation: (...args) => opened.push(args),
            onRetry: () => {
              retries += 1;
            },
          });
        },
      }),
    dom.root,
  );
  await settle();
  const text = () => dom.root.textContent?.replace(/\s+/g, " ") ?? "";
  return {
    dom,
    hrefs,
    opened,
    retries: () => retries,
    text,
    rows: () => Array.from(dom.root.querySelectorAll<HTMLElement>("[data-mail-event]")),
    cleanup: () => {
      dispose();
      disposeFeed();
      dom.cleanup();
    },
  };
};

test.skipIf(isServer)("lists events under their day, opens a conversation in place, and leaves events without one unlinked", async () => {
  const feed = await renderFeed({
    page: page([
      event("3", { action: "message.sent", metadata: { result: "failed", intent: "reply" } }),
      event("2", { action: "draft.created", conversationId: null, conversationSubject: null }),
      event("1", {
        actor: { kind: "workflow", id: null, displayName: "Rechnungen", avatarHash: null },
        action: "conversation.local_tags_added",
      }),
    ]),
  });
  try {
    expect(feed.text()).toContain("Heute");
    expect(feed.rows().map((row) => row.dataset.tone)).toEqual(["error", "draft", "automation"]);
    expect(feed.rows()[0]?.textContent).toContain("Details in der Unterhaltung.");
    expect(feed.rows()[1]?.querySelector("a")).toBeNull();
    expect(feed.rows()[2]?.querySelector(".mail-event__robot")).not.toBeNull();
    const link = feed.rows()[0]!.querySelector<HTMLAnchorElement>("a")!;
    expect(link.getAttribute("href")).toBe("/app/mail/Box001?view=events&conversation=Conv01");
    link.click();
    expect(feed.opened).toEqual([["/app/mail/Box001?view=events&conversation=Conv01", "Conv01", "Invoice 4711"]]);
    // A modified click keeps the link for a new tab.
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
    expect(feed.opened).toHaveLength(1);
  } finally {
    feed.cleanup();
  }
});

test.skipIf(isServer)("kind, person and concerns-me chips put the filter in the URL, and Reset clears it", async () => {
  const feed = await renderFeed({ page: page([event("1")]) });
  try {
    expect(feed.text()).not.toContain("Zurücksetzen");
    const mine = Array.from(feed.dom.root.querySelectorAll<HTMLElement>("a,button")).find((element) =>
      element.textContent?.includes("Betrifft mich"),
    )!;
    mine.click();
    expect(feed.hrefs.at(-1)).toBe("/app/mail/Box001?view=events&eventMine=1");

    feed.dom.root.querySelector<HTMLButtonElement>("[data-mail-events-filters] button[aria-haspopup]")!.click();
    await settle();
    const kinds = Array.from(feed.dom.document.querySelectorAll<HTMLElement>("[role='menuitemradio'],[role='menuitemcheckbox']"));
    expect(kinds.map((item) => item.textContent?.trim())).toEqual([
      "Zuweisungen",
      "Gesendet",
      "Entwürfe",
      "Erledigt",
      "Kommentare",
      "Automationen",
    ]);
    kinds[4]!.click();
    expect(feed.hrefs.at(-1)).toBe("/app/mail/Box001?view=events&eventKind=comment");
  } finally {
    feed.cleanup();
  }
  const filtered = await renderFeed({ page: page([event("1")], { kind: "comment", actorId: MIRA, mine: false }) });
  try {
    expect(filtered.text()).toContain("Art: Kommentare");
    expect(filtered.text()).toContain("Person: Mira Schulz");
    Array.from(filtered.dom.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Zurücksetzen")!
      .click();
    expect(filtered.hrefs.at(-1)).toBe("/app/mail/Box001?view=events");
  } finally {
    filtered.cleanup();
  }
});

test.skipIf(isServer)("shows the empty, filtered empty, loading and error states in the feed's place", async () => {
  const empty = await renderFeed({ page: page([]) });
  try {
    expect(empty.text()).toContain("Noch keine Ereignisse");
  } finally {
    empty.cleanup();
  }
  const none = await renderFeed({ page: page([], { kind: "sent", actorId: null, mine: true }) });
  try {
    expect(none.text()).toContain("Keine Ereignisse für diesen Filter");
    Array.from(none.dom.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Filter zurücksetzen")!
      .click();
    expect(none.hrefs.at(-1)).toBe("/app/mail/Box001?view=events");
  } finally {
    none.cleanup();
  }
  const loading = await renderFeed({ page: page([event("1")]), loading: true });
  try {
    expect(loading.dom.root.querySelector(".mail-events__skeleton[role='status']")?.textContent).toContain("Ereignisse werden geladen");
    expect(loading.rows()).toHaveLength(0);
    // The chips stay in place while the feed loads.
    expect(loading.dom.root.querySelector("[data-mail-events-filters]")).not.toBeNull();
  } finally {
    loading.cleanup();
  }
  const failed = await renderFeed({ page: null, error: "Keine Berechtigung" });
  try {
    expect(failed.dom.root.querySelector("[role='alert']")?.textContent).toContain("Ereignisse konnten nicht geladen werden.");
    Array.from(failed.dom.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Erneut versuchen")!
      .click();
    expect(failed.retries()).toBe(1);
  } finally {
    failed.cleanup();
  }
});

test.skipIf(isServer)("loads older events with the feed's filter, and a failed load keeps what is shown", async () => {
  const requests: string[] = [];
  let fail = true;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input instanceof Request ? input.url : input));
    if (fail)
      return new Response(JSON.stringify({ error: "Unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    return new Response(
      JSON.stringify({ items: [event("1", { id: "1", conversationId: "Conv09", conversationSubject: "Older" })], nextCursor: null }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;
  const feed = await renderFeed({ page: page([event("5")], { kind: "comment", actorId: null, mine: false }, "cursor-5") });
  try {
    const more = () => feed.dom.root.querySelector<HTMLButtonElement>("[data-mail-events-more]");
    more()!.click();
    await settle();
    expect(new URL(requests[0]!, "http://localhost").searchParams.get("kind")).toBe("comment");
    expect(new URL(requests[0]!, "http://localhost").searchParams.get("cursor")).toBe("cursor-5");
    expect(feed.rows()).toHaveLength(1);
    expect(feed.text()).toContain("Ältere Ereignisse konnten nicht geladen werden.");
    fail = false;
    Array.from(feed.dom.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.trim() === "Erneut versuchen")!
      .click();
    await settle();
    expect(feed.rows().map((row) => row.dataset.mailEvent)).toEqual(["5", "1"]);
    expect(more()).toBeNull();
  } finally {
    feed.cleanup();
  }
});
