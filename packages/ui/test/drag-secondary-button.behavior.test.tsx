import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness, type DomTestHarness } from "./dom";

/**
 * A secondary or middle press opens a context menu or pastes, and the menu can
 * swallow the release. A drag that started on such a press would keep holding
 * page text selection until some later release, so only the primary button
 * starts one.
 */
const pressWithEveryButton = (dom: DomTestHarness, target: HTMLElement) => {
  const win = dom.window as unknown as { PointerEvent: typeof PointerEvent };
  const pointer = (type: string, button: number, buttons: number) =>
    target.dispatchEvent(
      new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 5, pointerType: "mouse", isPrimary: true, button, buttons }),
    );
  const held = () => document.documentElement.style.getPropertyValue("user-select") === "none";
  const result: Record<string, boolean> = {};
  for (const [name, button, buttons] of [
    ["secondary", 2, 2],
    ["middle", 1, 4],
    ["primary", 0, 1],
  ] as const) {
    pointer("pointerdown", button, buttons);
    result[name] = held() && target.hasPointerCapture(5);
    pointer("pointerup", button, 0);
  }
  result.released = !held();
  return result;
};

const onlyPrimary = { secondary: false, middle: false, primary: true, released: true };

const overflow = async (element: HTMLElement, sizes: Record<string, number>) => {
  Object.defineProperties(
    element,
    Object.fromEntries(Object.entries(sizes).map(([key, value]) => [key, { configurable: true, writable: true, value }])),
  );
  element.dispatchEvent(new Event("scroll"));
  await Promise.resolve();
};

if (isServer) test.skip("requires browser conditions", () => {});
else {
  test("only a primary press on the DataTable scrollbar starts a drag", async () => {
    const dom = createDomTestHarness();
    const { default: DataTable } = await import("../src/content/DataTable");
    const dispose = render(
      () => createComponent(DataTable<{ id: string }>, { rows: [{ id: "one" }], columns: [{ id: "id", header: "ID", value: "id" }] }),
      dom.root,
    );
    try {
      await overflow(dom.root.querySelector<HTMLElement>(".k2b-table-wrap")!, { clientHeight: 100, scrollHeight: 400, scrollTop: 0 });
      const track = dom.root.querySelector<HTMLElement>('.k2b-data-table__scrollbar[data-axis="y"]')!;
      expect(pressWithEveryButton(dom, track)).toEqual(onlyPrimary);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("only a primary press on the ChoiceGroups scrollbar starts a drag", async () => {
    const dom = createDomTestHarness();
    const { ChoiceGroups } = await import("../src/inputs/ChoiceGroups");
    const dispose = render(
      () =>
        createComponent(ChoiceGroups, {
          ariaLabel: "Groups",
          value: null,
          onValueChange: () => undefined,
          choices: Array.from({ length: 8 }, (_, index) => ({ value: `group-${index}`, label: `Group ${index}` })),
        }),
      dom.root,
    );
    try {
      await overflow(dom.root.querySelector<HTMLElement>(".k2b-choice-groups")!, { clientWidth: 200, scrollWidth: 500, scrollLeft: 0 });
      const track = dom.root.querySelector<HTMLElement>(".k2b-choice-groups-scrollbar")!;
      expect(pressWithEveryButton(dom, track)).toEqual(onlyPrimary);
    } finally {
      dispose();
      dom.cleanup();
    }
  });

  test("only a primary press on a Panes tab scrollbar or separator starts a drag", async () => {
    const dom = createDomTestHarness();
    const { default: Panes } = await import("../src/layout/Panes");
    const itemIds = Array.from({ length: 12 }, (_, index) => `item${index}`);
    const dispose = render(
      () =>
        createComponent(Panes, {
          layout: {
            version: 2,
            root: {
              type: "split",
              direction: "horizontal",
              ratio: 0.5,
              first: { type: "group", items: itemIds, active: itemIds[0]! },
              second: { type: "group", items: ["history"], active: "history" },
            },
          },
          onLayoutChange: () => undefined,
          items: [...itemIds, "history"].map((id) => ({ id, title: id, render: () => id })),
        }),
      dom.root,
    );
    try {
      await overflow(dom.root.querySelector<HTMLElement>(".k2b-panes__tabs")!, { clientWidth: 200, scrollWidth: 400, scrollLeft: 0 });
      const track = dom.root.querySelector<HTMLElement>(".k2b-panes__tabs-scrollbar")!;
      expect(pressWithEveryButton(dom, track)).toEqual(onlyPrimary);
      const separator = dom.root.querySelector<HTMLElement>(".k2b-panes__separator")!;
      expect(pressWithEveryButton(dom, separator)).toEqual(onlyPrimary);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
