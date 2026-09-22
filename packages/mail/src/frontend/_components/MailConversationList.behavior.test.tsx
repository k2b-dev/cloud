import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { Mailbox } from "../../contracts";

test.skipIf(isServer)("overscrolling the conversation list at its top runs the workspace refresh once", async () => {
  const dom = createDomTestHarness();
  const { default: MailConversationList } = await import("./MailConversationList");
  let refreshes = 0;
  let finish!: () => void;
  const dispose = render(
    () =>
      createComponent(MailConversationList, {
        mailbox: { id: "Box001", name: "Support", health: "healthy" } as unknown as Mailbox,
        mailboxId: "Box001",
        requestUrl: "/app/mail/Box001?view=needs_action",
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
        listMode: "conversations",
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
        onBulkAction: () => {},
        onItemAction: () => {},
        onManageTags: () => {},
        onMergeItem: () => {},
        onOpenHref: () => {},
        onLoadMore: () => true,
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
