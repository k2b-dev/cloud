import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
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
  onCollapse: () => {},
  onOpenHealth: () => {},
  onOpenDeliverySettings: () => {},
  onNavigate: () => {},
  onNavigateItem: () => {},
  onToggleSelectionMode: () => {},

  onToggleSelection: () => {},
  onClearSelection: () => {},
  onAddTags: () => {},
  onAssign: () => {},
  onBulkAction: () => {},
  onItemAction: () => {},
  onManageTags: () => {},
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

test.skipIf(isServer)("search filters open one builder however often they are pressed while its code loads", async () => {
  const dom = createDomTestHarness();
  const { createMailboxSearch } = await import("./mailbox-search");
  const { MailSearchInput, MailSearchOptions } = await import("./MailWorkspaceSearch");
  const MailSearchHarness = (props: Parameters<typeof createMailboxSearch>[0]) => {
    const search = createMailboxSearch(props);
    return [createComponent(MailSearchInput, { search, mailboxName: "Support" }), createComponent(MailSearchOptions, { search, count: 0 })];
  };
  const dispose = render(() => createComponent(MailSearchHarness, { ...listProps("/app/mail/Box001?q=sdsd"), query: "sdsd" }), dom.root);
  try {
    const filters = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Search filters"]')!;
    filters.click();
    // The trigger shows that it is busy and stays enabled, so it keeps focus for the dialog to return it.
    expect(filters.getAttribute("aria-busy")).toBe("true");
    expect(filters.disabled).toBe(false);
    expect(filters.querySelector("i.ti-loader-2")).not.toBeNull();
    filters.click();
    filters.click();
    expect(dom.root.querySelector(".mail-search-summary")).toBeNull();
    for (let attempt = 0; attempt < 100 && filters.hasAttribute("aria-busy"); attempt += 1) await Bun.sleep(5);
    expect(searchBuilderOpens).toHaveLength(1);
    expect(filters.hasAttribute("aria-busy")).toBe(false);
    expect(filters.querySelector("i.ti-adjustments-search")).not.toBeNull();
  } finally {
    dispose();
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
    const { createMailboxSearch } = await import("./mailbox-search");
    const { MailSearchInput, MailSearchOptions } = await import("./MailWorkspaceSearch");
    const MailSearchHarness = (props: Parameters<typeof createMailboxSearch>[0]) => {
      const search = createMailboxSearch(props);
      return [
        createComponent(MailSearchInput, { search, mailboxName: "Support" }),
        createComponent(MailSearchOptions, { search, count: 0 }),
      ];
    };
    const dispose = render(
      () =>
        createComponent(MailSearchHarness, {
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
        }),
      dom.root,
    );
    try {
      const before = searchBuilderOpens.length;
      dom.root.querySelector<HTMLButtonElement>('button[aria-label="Search filters"]')!.click();
      const deadline = performance.now() + 2000;
      while (searchBuilderOpens.length === before && performance.now() < deadline) await Bun.sleep(1);
      expect(searchBuilderOpens.at(-1)).toMatchObject({ initialState: { expression: { query: expected } } });
    } finally {
      dispose();
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
  const { createMailboxSearch } = await import("./mailbox-search");
  const { MailSearchOptions } = await import("./MailWorkspaceSearch");
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
  const dispose = render(() => {
    const search = createMailboxSearch({
      ...listProps(route),
      query: "invoice",
      folders: [mailTestFolder("Inbox1", { name: "Inbox" }), mailTestFolder("Trash1", { name: "Trash" })],
      onOpenHref: (href) => {
        navigations.push(href);
      },
    });
    return createComponent(MailSearchOptions, { search, count: 0 });
  }, dom.root);
  try {
    const scope = dom.root.querySelector<HTMLButtonElement>('button[aria-label="Place: Only Trash"]');
    expect(scope).not.toBeNull();
    scope!.click();
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    const options = [...dom.document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]')];
    expect(options.map((option) => option.textContent)).toContain("Only Inbox");
    const whole = options.find((option) => option.textContent?.trim() === "Whole mailbox");
    expect(whole).toBeDefined();
    whole!.click();
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    expect(navigations).toHaveLength(1);
    const next = new URL(navigations[0]!, "https://cloud.test");
    expect(next.searchParams.has("search")).toBe(false);
    expect(next.searchParams.get("q")).toBe("invoice");
  } finally {
    dispose();
    dom.cleanup();
  }
});
