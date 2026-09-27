import { describe, expect, mock, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { createDomTestHarness } from "../../ui/test/dom";

const now = "2026-09-26T08:00:00.000Z";
const userId = "33333333-3333-4333-8333-333333333333";
const item: SpaceItem = {
  id: "Item01",
  spaceId: "Space1",
  columnId: null,
  title: "Publish release",
  description: "Wait for the scope approval.",
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  activeBlockerCount: 1,
  priority: null,
  recurrence: null,
  recurringEventId: null,
  recurrenceId: null,
  rank: "1024",
  completedAt: null,
  createdBy: userId,
  createdAt: now,
  updatedAt: now,
  assignees: [],
  tags: [],
  claim: null,
};

if (!isServer) mock.module("@/api/client", () => ({ apiClient: {} }));

describe("Spaces detail blocker hint", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("jumps to the first active blocker inside the panel without changing the URL", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const href = "http://localhost/app/spaces/Space1?view=list&item=Item01";
    dom.window.history.replaceState(null, "", href);
    const scrolled: Element[] = [];
    dom.window.HTMLElement.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    const { default: ItemDetailPanel } = await import("../src/frontend/[id]/_components/detail/ItemDetailPanel");
    const dispose = render(
      () =>
        createComponent(ItemDetailPanel, {
          item,
          columns: [],
          tags: [],
          wormholes: [],
          spaceId: item.spaceId,
          baseUrl: "/app/spaces/Space1?view=list",
          currentUserId: userId,
          initialCommentsPage: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
          commentTarget: { itemId: item.id, recurrenceId: null },
          recurringContext: null,
          blockedBy: [
            { blocker: { id: "Done01", spaceId: item.spaceId, title: "Draft scope", completedAt: now }, createdAt: now },
            { blocker: { id: "Block1", spaceId: item.spaceId, title: "Approve scope", completedAt: null }, createdAt: now },
          ],
          canWrite: false,
          mailIntegrationAvailable: false,
          scrollPreserveKey: "test-detail",
        }),
      dom.root,
    );

    const hint = dom.root.querySelector<HTMLAnchorElement>('a[href^="#spaces-blockers-"]')!;
    expect(hint.textContent).toBe("Blocked by 1 task");
    const list = dom.document.getElementById(hint.getAttribute("href")!.slice(1))!;
    expect(list.textContent).toContain("Approve scope");

    const click = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    hint.dispatchEvent(click as unknown as Event);

    expect(click.defaultPrevented).toBe(true);
    expect(dom.window.location.href).toBe(href);
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0]!.tagName).toBe("SECTION");
    expect(scrolled[0]!.querySelector("h3")?.textContent).toBe("Blocked by");
    // Focus lands on the first active blocker's link, skipping the completed one, so Enter opens it right away.
    const focused = dom.document.activeElement;
    expect(focused?.tagName).toBe("A");
    expect(list.contains(focused)).toBe(true);
    expect(focused?.getAttribute("href")).toBe("/app/spaces/Space1?view=list&item=Block1");
    expect(focused?.textContent).toContain("Approve scope");

    dispose();
    dom.cleanup();
  });
});
