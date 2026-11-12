import { expect, mock, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { Mailbox } from "../../contracts";
import { resolveMailSearchRoute } from "../../search-state";
import { mailTestFolder } from "./mail-list-test-fixtures";

/** The builder's dialog itself has its own tests; here only how often the list opens it matters. */
const searchBuilderOpens: unknown[] = [];
mock.module("./MailSearchBuilder", () => ({
  openMailSearchBuilder: async (params: unknown) => {
    searchBuilderOpens.push(params);
    return undefined;
  },
}));

const listProps = (requestUrl: string) => ({
  mailbox: { id: "Box001", name: "Support", health: "healthy" } as unknown as Mailbox,
  mailboxId: "Box001",
  requestUrl,
  search: resolveMailSearchRoute(new URL(requestUrl, "https://cloud.test")),
  query: "",
  title: "Needs action",
  namedBy: "tabs" as const,
  items: [],
  error: null,
  selectedConversationId: null,
  selectedMessageId: null,
  selectedConversationIds: new Set<string>(),
  selectionMode: false,
  nextCursor: null,
  dateConfig: { locale: "en", timeZone: "UTC" },
  canWrite: true,
  canAdmin: false,
  viewFolderId: null,
  folders: [],
  localTags: [],
  savedViews: [],
  activeSavedViewId: null,
  listMode: "conversations" as const,
  loading: false,
  liveDegraded: false,
  onOpenHealth: () => {},
  onOpenDeliverySettings: () => {},
  onNavigate: () => {},
  onNavigateItem: () => {},

  onToggleSelection: () => {},
  onClearSelection: () => {},
  onAddTags: () => {},
  onAssign: () => {},
  onBulkAction: () => {},
  onItemAction: () => {},
  onManageTags: () => {},
  onRespondItem: () => {},
  onSetItemCompletion: () => {},
  currentUserId: null,
  assigneeNames: () => [],
  onMergeItem: () => {},
  onOpenHref: () => {},
  onLoadMore: () => true,
});

test.skipIf(isServer)("overscrolling the conversation list at its top runs the workspace refresh once", async () => {
  const dom = createDomTestHarness();
  const { default: MailConversationList } = await import("./MailConversationList");
  let refreshes = 0;
  let finish!: () => void;
  const dispose = render(
    () =>
      createComponent(MailConversationList, {
        ...listProps("/app/mail/Box001?view=needs_action"),
        onRefresh: () => {
          refreshes += 1;
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      }),
    dom.root,
  );
  try {
    const wrapper = dom.root.querySelector<HTMLElement>(".k2b-pull-to-refresh")!;
    const port = wrapper.querySelector<HTMLElement>(".k2b-scroll-area")!;
    const WheelEventCtor = (dom.window as unknown as { WheelEvent: typeof WheelEvent }).WheelEvent;
    const overscroll = () => port.dispatchEvent(new WheelEventCtor("wheel", { bubbles: true, deltaY: -200 }));
    expect(wrapper.dataset.state).toBe("idle");
    overscroll();
    expect(wrapper.dataset.state).toBe("refreshing");
    expect(wrapper.querySelector('[role="status"]')?.textContent).toBe("Refreshing conversations");
    overscroll();
    expect(refreshes).toBe(1);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wrapper.dataset.state).toBe("idle");
  } finally {
    dispose();
    dom.cleanup();
  }
});

/** The head's search field with its filter button, as the mailbox renders them. */
const renderSearch = async (
  dom: ReturnType<typeof createDomTestHarness>,
  props: Parameters<typeof import("./mailbox-search").createMailboxSearch>[0],
) => {
  const { createMailboxSearch } = await import("./mailbox-search");
  const { MailSearchInput } = await import("./MailWorkspaceSearch");
  const { MailSearchFilter } = await import("./MailWorkspaceHead");
  const { resolveMailSearchRoute: resolve } = await import("../../search-state");
  let search!: ReturnType<typeof createMailboxSearch>;
  const dispose = render(() => {
    search = createMailboxSearch(props);
    return createComponent(MailSearchInput, {
      search,
      mailboxName: "Support",
      get children() {
        return createComponent(MailSearchFilter, {
          requestUrl: props.requestUrl,
          search: resolve(new URL(props.requestUrl, "https://cloud.test")),
          folders: props.folders,
          folderId: null,
          localTags: props.localTags,
          quickSearch: search,
          onOpenHref: (href) => void props.onOpenHref(href),
          onEditSearch: () => {},
          hint: { open: false, onDismiss: () => {} },
        });
      },
    });
  }, dom.root);
  const filterButton = () => dom.root.querySelector<HTMLButtonElement>("[data-mail-filter-button]")!;
  /** Opens the filter menu and returns its entries. */
  const openFilters = async () => {
    filterButton().click();
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    const menu = dom.document.getElementById(filterButton().getAttribute("aria-controls")!)!;
    return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]')];
  };
  return { dispose, search: () => search, filterButton, openFilters };
};

test.skipIf(isServer)("More filters opens one builder however often it is chosen while its code loads", async () => {
  const dom = createDomTestHarness();
  const view = await renderSearch(dom, { ...listProps("/app/mail/Box001?q=sdsd"), query: "sdsd" });
  try {
    const more = (await view.openFilters()).find((item) => item.textContent?.includes("More filters"))!;
    more.click();
    // The button shows that the builder loads and stays enabled, so it keeps focus for the dialog to return it.
    expect(view.filterButton().getAttribute("aria-busy")).toBe("true");
    expect(view.filterButton().disabled).toBe(false);
    expect(view.filterButton().querySelector("i.ti-loader-2")).not.toBeNull();
    more.click();
    more.click();
    for (let attempt = 0; attempt < 100 && view.filterButton().hasAttribute("aria-busy"); attempt += 1) await Bun.sleep(5);
    expect(searchBuilderOpens).toHaveLength(1);
    expect(view.filterButton().hasAttribute("aria-busy")).toBe(false);
    expect(view.filterButton().querySelector("i.ti-adjustments-horizontal")).not.toBeNull();
  } finally {
    view.dispose();
    dom.cleanup();
  }
});

for (const [query, expected] of [
  ["?q=quick", "saved"],
  ["?search=invalid&q=quick", "saved"],
  [
    `?${new URLSearchParams({ search: JSON.stringify({ expression: { type: "text", field: "from", query: "structured", match: "exact" }, sort: "newest" }), q: "quick" })}`,
    "structured",
  ],
]) {
  test.skipIf(isServer)(`the list builder retains structured, saved-view, quick-search precedence: ${query}`, async () => {
    const dom = createDomTestHarness();
    const view = await renderSearch(dom, {
      ...listProps(`/app/mail/Box001${query}`),
      activeSavedViewId: "View01",
      savedViews: [
        {
          id: "View01",
          mailboxId: "Box001",
          scope: "private",
          ownerUserId: "user-1",
          name: "Saved",
          filter: { expression: { type: "text", field: "subject", query: "saved", match: "words" }, sort: "newest" },
          revision: 1,
          createdAt: "2026-10-14T10:00:00Z",
          updatedAt: "2026-10-14T10:00:00Z",
        },
      ],
    });
    try {
      const before = searchBuilderOpens.length;
      (await view.openFilters()).find((item) => item.textContent?.includes("More filters"))!.click();
      const deadline = performance.now() + 2000;
      while (searchBuilderOpens.length === before && performance.now() < deadline) await Bun.sleep(1);
      expect(searchBuilderOpens.at(-1)).toMatchObject({ initialState: { expression: { query: expected } } });
    } finally {
      view.dispose();
      dom.cleanup();
    }
  });
}

test.skipIf(isServer)("a long folder search stays editable and does not navigate beyond URL limits", async () => {
  const dom = createDomTestHarness();
  const { createMailboxSearch } = await import("./mailbox-search");
  const { MailSearchInput } = await import("./MailWorkspaceSearch");
  const query = "x".repeat(500);
  const route = `/app/mail/Box001?${new URLSearchParams({ q: query, qFields: "from,recipients,subject,body,attachment_name", searchFrom: "folder=Inbox1" })}`;
  const navigations: string[] = [];
  let search!: ReturnType<typeof createMailboxSearch>;
  const dispose = render(() => {
    search = createMailboxSearch({
      ...listProps(route),
      query,
      folders: [mailTestFolder("Inbox1", { name: "Inbox" })],
      onOpenHref: (href) => {
        navigations.push(href);
      },
    });
    return createComponent(MailSearchInput, { search, mailboxName: "Support" });
  }, dom.root);
  try {
    search.updateScope("Inbox1");
    expect(navigations).toEqual([]);
    expect(search.validationError()).toBe(true);
    expect(dom.root.querySelector('[role="alert"]')?.textContent).toContain("Shorten the text");
    expect(dom.root.querySelector<HTMLInputElement>('input[name="q"]')?.value).toBe(query);
    search.updateSearchValue("invoice");
    search.submitSearch(new Event("submit", { cancelable: true }) as SubmitEvent);
    expect(navigations).toHaveLength(1);
    const next = new URL(navigations[0]!, "https://cloud.test");
    expect(next.searchParams.get("q")).toBe("invoice");
    expect(resolveMailSearchRoute(next).expression).toMatchObject({
      type: "and",
      expressions: [{ type: "folder_id", folderId: "Inbox1" }, { type: "or" }],
    });
    expect(search.validationError()).toBe(false);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("a direct folder search names its actual scope and can return to the whole mailbox", async () => {
  const dom = createDomTestHarness();
  const { simpleMailSearchExpression } = await import("../../search-url");
  const route = `/app/mail/Box001?${new URLSearchParams({
    q: "invoice",
    searchFrom: "folder=Inbox1",
    search: JSON.stringify({
      expression: { type: "and", expressions: [{ type: "folder_id", folderId: "Trash1" }, simpleMailSearchExpression("invoice", ["any"])] },
      sort: "newest",
    }),
  })}`;
  const navigations: string[] = [];
  const view = await renderSearch(dom, {
    ...listProps(route),
    query: "invoice",
    folders: [mailTestFolder("Inbox1", { name: "Inbox" }), mailTestFolder("Trash1", { name: "Trash" })],
    onOpenHref: (href) => {
      navigations.push(href);
    },
  });
  try {
    // While searching, the place counts as a filter and the menu names it.
    expect(view.filterButton().getAttribute("aria-label")).toBe("Filters, 1 active");
    const options = await view.openFilters();
    const labels = options.map((option) => option.textContent?.trim());
    expect(labels).toContain("Only Inbox");
    expect(options.find((option) => option.textContent?.trim() === "Only Trash")?.getAttribute("aria-checked")).toBe("true");
    const whole = options.find((option) => option.textContent?.trim() === "Whole mailbox");
    expect(whole).toBeDefined();
    whole!.click();
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(navigations).toHaveLength(1);
    const next = new URL(navigations[0]!, "https://cloud.test");
    expect(next.searchParams.has("search")).toBe(false);
    expect(next.searchParams.get("q")).toBe("invoice");
  } finally {
    view.dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("an old page completion cannot mark the new A list as failed after A → B → A", async () => {
  const dom = createDomTestHarness();
  const { default: MailConversationList } = await import("./MailConversationList");
  delegateEvents(["click"], dom.document);
  const [mailboxId, setMailboxId] = createSignal("Box001");
  let finish = (_loaded: boolean) => {};
  const pending = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  let loads = 0;
  const dispose = render(
    () =>
      createComponent(MailConversationList, {
        ...listProps("/app/mail/Box001"),
        get mailboxId() {
          return mailboxId();
        },
        get requestUrl() {
          return `/app/mail/${mailboxId()}`;
        },
        nextCursor: "next",
        onLoadMore: () => {
          loads++;
          return pending;
        },
        onRefresh: async () => {},
      }),
    dom.root,
  );
  try {
    const more = () => dom.root.querySelector<HTMLAnchorElement>('a[href*="cursor="]')!;
    more().click();
    expect(loads).toBe(1);
    setMailboxId("Box002");
    setMailboxId("Box001");
    expect(more().textContent).toContain("More conversations");
    finish(false);
    await Bun.sleep(0);
    expect(more().textContent).toContain("More conversations");
    expect(more().textContent).not.toContain("Retry loading");
  } finally {
    finish(false);
    dispose();
    dom.cleanup();
  }
});

test.skipIf(isServer)("a work list names the done conversations it leaves out at its end, with the way to them", async () => {
  const dom = createDomTestHarness();
  const [{ default: MailConversationList }, { LocaleProvider }] = await Promise.all([import("./MailConversationList"), import("@k2b/ui")]);
  const [hidden, setHidden] = createSignal<{ count: number | null; more: boolean; href: string } | null>({
    count: 1207,
    more: false,
    href: "/app/mail/Box001?view=done",
  });
  const [nextCursor, setNextCursor] = createSignal<string | null>("next");
  const [locale, setLocale] = createSignal<"en" | "de">("en");
  const [error, setError] = createSignal<"load_failed" | null>(null);
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        get locale() {
          return locale();
        },
        get children() {
          return createComponent(MailConversationList, {
            ...listProps("/app/mail/Box001"),
            title: "All",
            get hiddenDone() {
              return hidden();
            },
            get nextCursor() {
              return nextCursor();
            },
            get error() {
              return error();
            },
            onNavigate: () => {},
            onRefresh: async () => {},
          });
        },
      }),
    dom.root,
  );
  const footer = () => dom.root.querySelector<HTMLElement>("[data-mail-hidden-done]");
  try {
    // More pages follow: the footer waits for the list's end.
    expect(footer()).toBeNull();
    setNextCursor(null);
    expect(footer()?.textContent).toBe("1,207 done conversations·Show done");
    // An empty list keeps its empty state and still offers the way to done conversations.
    expect(dom.root.querySelector(".k2b-placeholder")).not.toBeNull();
    const link = footer()!.querySelector<HTMLAnchorElement>("[data-mail-show-done]")!;
    expect(link.getAttribute("href")).toBe("/app/mail/Box001?view=done");
    setLocale("de");
    expect(footer()?.textContent).toBe("1.207 erledigte Unterhaltungen·Erledigt anzeigen");
    setHidden({ count: 1, more: false, href: "/app/mail/Box001?view=done" });
    expect(footer()?.textContent).toBe("1 erledigte Unterhaltung·Erledigt anzeigen");
    setHidden({ count: 1000, more: true, href: "/app/mail/Box001?view=done" });
    expect(footer()?.textContent).toBe("Mehr als 1.000 erledigte Unterhaltungen·Erledigt anzeigen");
    // An uncounted list still offers the link; a list without done conversations shows no footer.
    setHidden({ count: null, more: false, href: "/app/mail/Box001?view=done" });
    expect(footer()?.textContent).toBe("Erledigt anzeigen");
    setHidden({ count: 0, more: false, href: "/app/mail/Box001?view=done" });
    expect(footer()).toBeNull();
    // A failed list shows its error and retry, not the footer.
    setHidden({ count: 3, more: false, href: "/app/mail/Box001?view=done" });
    setError("load_failed");
    expect(footer()).toBeNull();
    setError(null);
    expect(footer()).not.toBeNull();
  } finally {
    dispose();
    dom.cleanup();
  }
});
