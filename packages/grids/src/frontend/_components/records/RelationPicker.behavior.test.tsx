import { expect, mock, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";

const domTest = isServer ? test.skip : test;
const targets = [
  { id: "REC002", label: "Acme" },
  { id: "REC003", label: "Globex" },
];
let lookups = 0;
mock.module("./record-lookup", () => ({
  fetchRecordLookup: async (params: { excludeIds?: string[] }) => {
    lookups++;
    return targets.filter((target) => !params.excludeIds?.includes(target.id));
  },
}));

const waitFor = async (condition: () => boolean, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition was not met in time");
    await Bun.sleep(5);
  }
};

domTest("a picked record keeps its label once the lookup list no longer contains it", async () => {
  const dom = createDomTestHarness();
  const prototype = dom.window.HTMLElement.prototype;
  const opened = new WeakSet<object>();
  const matches = prototype.matches;
  prototype.matches = function (selector: string) {
    return selector === ":popover-open" ? opened.has(this) : matches.call(this, selector);
  };
  Object.assign(prototype, {
    showPopover(this: object) {
      opened.add(this);
    },
    hidePopover(this: object) {
      opened.delete(this);
    },
    scrollIntoView() {},
  });
  const { default: RelationPicker } = await import("./RelationPicker");
  const [value, setValue] = createSignal<string[]>([]);
  const dispose = render(
    () =>
      createComponent(RelationPicker, {
        targetTableId: "TABLE2",
        value,
        labels: () => ({}),
        multi: true,
        onChange: setValue,
      }),
    dom.root,
  );
  const trigger = () => dom.root.querySelector<HTMLElement>(".k2b-multi-select-trigger")!;
  const option = (label: string) => dom.root.querySelector<HTMLButtonElement>(`[role='option'][aria-label='${label}']`);
  const chips = () => Array.from(dom.root.querySelectorAll(".k2b-choice-pill")).map((pill) => pill.textContent?.trim());
  try {
    trigger().click();
    await waitFor(() => option("Acme") !== null);
    option("Acme")!.click();
    await waitFor(() => value().length === 1);
    expect(chips()).toEqual(["Acme"]);

    // Reopening searches again and excludes the record that is already linked.
    trigger().click();
    trigger().click();
    await waitFor(() => lookups === 2 && option("Globex") !== null && option("Acme") === null);
    expect(value()).toEqual(["REC002"]);
    expect(chips()).toEqual(["Acme"]);
  } finally {
    dispose();
    dom.cleanup();
  }
});
