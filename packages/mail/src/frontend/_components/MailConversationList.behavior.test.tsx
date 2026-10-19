import { expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { Mailbox } from "../../contracts";
import { resolveMailSearchRoute } from "../../search-state";

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
  namedByTabs: true,
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
  const { default: MailConversationList } = await import("./MailConversationList");
  const dispose = render(
    () => createComponent(MailConversationList, { ...listProps("/app/mail/Box001?q=sdsd"), query: "sdsd", onRefresh: async () => {} }),
    dom.root,
  );
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
    const { default: MailConversationList } = await import("./MailConversationList");
    const dispose = render(
      () =>
        createComponent(MailConversationList, {
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
          onRefresh: async () => {},
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
