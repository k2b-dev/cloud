import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import type { SpaceItem } from "@/contracts";
import { createDomTestHarness, type DomTestHarness } from "../../ui/test/dom";

const now = "2026-09-26T08:00:00.000Z";
const userId = "33333333-3333-4333-8333-333333333333";
const item: SpaceItem = {
  id: "Item01",
  spaceId: "Space1",
  columnId: null,
  title: "Publish release",
  description: null,
  location: null,
  url: null,
  startsAt: null,
  endsAt: null,
  allDay: false,
  deadline: null,
  estimatedDurationMinutes: null,
  activeBlockerCount: 4,
  priority: "medium",
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

const _flush = async () => {
  // A v2 menu answers a choice after its close settles, a few frames later.
  for (let step = 0; step < 5; step += 1) await Promise.resolve();
  await Bun.sleep(20);
};

const mount = async (dom: DomTestHarness, overrides: { canWrite?: boolean } = {}) => {
  const { DetailPaneFixture } = await import("./detail-pane");
  const blocker = (index: number) => ({
    blocker: { id: `Blk00${index}`, spaceId: item.spaceId, title: `Step ${index}`, completedAt: index === 0 ? now : null },
    createdAt: now,
  });
  const detail = {
    item,
    comments: { items: [], page: 1, perPage: 50, total: 0, hasNext: false },
    commentTarget: { itemId: item.id, recurrenceId: null },
    recurringContext: null,
    references: [],
    links: [],
    attachments: [],
    checklist: [],
    blockedBy: [0, 1, 2, 3, 4].map(blocker),
    blocks: [],
  };
  return render(
    () => createComponent(DetailPaneFixture, { detail: () => detail, canWrite: overrides.canWrite ?? true, currentUserId: userId }),
    dom.root,
  );
};

describe("Spaces detail planning rows", () => {
  if (isServer) {
    test.skip("runs in the dedicated browser-conditions test process", () => {});
    return;
  }

  test("folds five blockers to three, open ones first, and unfolds them on request", async () => {
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    const dispose = await mount(dom, { canWrite: false });
    const titles = () =>
      Array.from(dom.root.querySelectorAll('section[aria-label="Blocked by"] .k2-row-title'), (title) => title.textContent);

    expect(titles()).toEqual(["Step 1", "Step 2", "Step 3"]);
    const toggle = Array.from(dom.root.querySelectorAll<HTMLButtonElement>('section[aria-label="Blocked by"] button')).find(
      (button) => button.textContent?.trim() === "2 more",
    )!;
    expect(toggle.textContent?.trim()).toBe("2 more");

    toggle.click();
    expect(titles()).toEqual(["Step 1", "Step 2", "Step 3", "Step 4", "Step 0"]);
    expect(toggle.textContent?.trim()).toBe("Show fewer");
    // The toggle stays the same button below the list, so keyboard focus stays on it.
    expect(toggle.isConnected).toBe(true);

    toggle.click();
    expect(titles()).toEqual(["Step 1", "Step 2", "Step 3"]);
    dispose();
    dom.cleanup();
  });
});
