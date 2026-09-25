import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { Mailbox } from "../../contracts";

const listProps = (requestUrl: string) => ({
  mailbox: { id: "Box001", name: "Support", health: "healthy" } as unknown as Mailbox,
  mailboxId: "Box001",
  requestUrl,
  query: "",
  title: "Needs action",
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
  junkFolderIds: [],
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
  onListModeChange: () => {},
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

test.skipIf(isServer)("the structured search summary is one named button that covers its icon and text", async () => {
  const dom = createDomTestHarness();
  const { default: MailConversationList } = await import("./MailConversationList");
  const dispose = render(
    () => createComponent(MailConversationList, { ...listProps("/app/mail/Box001?q=sdsd"), query: "sdsd", onRefresh: async () => {} }),
    dom.root,
  );
  try {
    const summary = dom.root.querySelector<HTMLButtonElement>(".mail-search-summary")!;
    expect(summary.tagName).toBe("BUTTON");
    expect(summary.type).toBe("button");
    expect(summary.getAttribute("aria-label")).toMatch(/^Edit structured search: .*sdsd/);
    expect(summary.tabIndex).toBe(0);
    // Every visible part of the line sits inside the one button, so there is no gap with another cursor.
    expect(Array.from(summary.children, (child) => child.tagName)).toEqual(["I", "SPAN"]);
    expect(summary.querySelector("i.ti-filter-check")?.getAttribute("aria-hidden")).toBe("true");
    expect(summary.querySelector(".mail-search-summary__text")?.textContent).toContain("sdsd");
    expect(summary.parentElement?.querySelectorAll(":scope > button.mail-search-summary")).toHaveLength(1);
  } finally {
    dispose();
    dom.cleanup();
  }
});
