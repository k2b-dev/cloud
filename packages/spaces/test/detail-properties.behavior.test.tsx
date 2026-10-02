import { describe, expect, mock, test } from "bun:test";
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};
const patches: Array<{ json: unknown; response: ReturnType<typeof deferred<Response>> }> = [];
if (!isServer)
  mock.module("@/api/client", () => ({
    apiClient: {
      [":id"]: {
        items: {
          [":itemId"]: {
            $patch: ({ json }: { json: unknown }) => {
              const response = deferred<Response>();
              patches.push({ json, response });
              return response.promise;
            },
          },
        },
      },
    },
  }));

/** happy-dom has no popover API; the pickers only need open state. */
const installPopoverApi = (dom: DomTestHarness) => {
  const prototype = dom.window.HTMLElement.prototype as unknown as HTMLElement;
  const open = new WeakSet<Element>();
  const matches = prototype.matches;
  Object.assign(prototype, {
    matches(this: Element, selector: string) {
      return selector === ":popover-open" ? open.has(this) : matches.call(this, selector);
    },
    showPopover(this: HTMLElement) {
      open.add(this);
    },
    hidePopover(this: HTMLElement) {
      open.delete(this);
    },
    scrollIntoView() {},
  });
};

const flush = async () => {
  for (let step = 0; step < 5; step += 1) await Promise.resolve();
};

const mount = async (dom: DomTestHarness, overrides: Record<string, unknown> = {}) => {
  const { default: ItemDetailPanel } = await import("../src/frontend/[id]/_components/detail/ItemDetailPanel");
  const blocker = (index: number) => ({
    blocker: { id: `Blk00${index}`, spaceId: item.spaceId, title: `Step ${index}`, completedAt: index === 0 ? now : null },
    createdAt: now,
  });
  return render(
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
        blockedBy: [0, 1, 2, 3, 4].map(blocker),
        canWrite: true,
        mailIntegrationAvailable: false,
        scrollPreserveKey: "test-detail",
        ...overrides,
      }),
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
      Array.from(dom.root.querySelectorAll('[data-spaces-dependencies="blocker"] a .spaces-dependency__title'), (title) => title.textContent);

    expect(titles()).toEqual(["Step 1", "Step 2", "Step 3"]);
    const toggle = dom.root.querySelector<HTMLButtonElement>(".spaces-dependency__more")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("2 more");

    toggle.click();
    expect(titles()).toEqual(["Step 1", "Step 2", "Step 3", "Step 4", "Step 0"]);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Show fewer");
    // The toggle stays the same button below the list, so keyboard focus stays on it.
    expect(dom.root.querySelector(".spaces-dependency__more")).toBe(toggle);

    toggle.click();
    expect(titles()).toEqual(["Step 1", "Step 2", "Step 3"]);
    dispose();
    dom.cleanup();
  });

  test("shows a new priority at once, ignores a second pick while saving, and falls back when the save fails", async () => {
    patches.length = 0;
    const dom = createDomTestHarness();
    dom.root.className = "k2b-ui";
    installPopoverApi(dom);
    const dispose = await mount(dom);
    const row = Array.from(dom.root.querySelectorAll(".k2b-description-list__item")).find(
      (candidate) => candidate.querySelector("dt")?.textContent === "Priority",
    )!;
    const trigger = row.querySelector<HTMLButtonElement>(".k2b-choice-trigger")!;
    const value = () => trigger.querySelector(".k2b-choice-trigger__value")?.textContent;
    const pick = (label: string) => {
      trigger.click();
      Array.from(row.querySelectorAll<HTMLButtonElement>("[role='option']"))
        .find((option) => option.textContent === label)!
        .click();
    };

    expect(value()).toBe("Medium");
    pick("Low");
    await flush();
    expect(value()).toBe("Low");
    expect(patches.map((patch) => patch.json)).toEqual([{ priority: "low" }]);

    pick("Urgent");
    await flush();
    expect(patches).toHaveLength(1);
    expect(value()).toBe("Low");

    patches[0]!.response.resolve(Response.json({ message: "Priority could not be saved" }, { status: 500 }));
    for (let step = 0; step < 20 && value() !== "Medium"; step += 1) await Bun.sleep(5);
    expect(value()).toBe("Medium");
    dispose();
    dom.cleanup();
  });
});
