import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { delegateEvents, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

test("click and arrow keys choose a row, focus follows, and details open under the chosen row", async () => {
  const dom = createDomTestHarness();
  const { ChoiceList } = await import("../src/inputs/ChoiceList");
  const [value, setValue] = createSignal<string | null>("all");
  const committed: string[] = [];
  const dispose = render(
    () =>
      createComponent(ChoiceList, {
        "aria-label": "Level",
        options: [
          { value: "all", label: "All" },
          { value: "mentions", label: "Mentions" },
          { value: "off", label: "Off" },
        ],
        value,
        onValueChange: setValue,
        onValueCommit: (next: string) => committed.push(next),
        get details() {
          return value() === "off" ? "For 8 hours" : undefined;
        },
      }),
    dom.root,
  );
  const radios = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const details = () => dom.root.querySelector(".k2b-choice-list__details");
  radios()[2]!.click();
  await flush();
  expect(value()).toBe("off");
  expect(details()?.previousElementSibling).toBe(radios()[2]!);
  expect(details()?.textContent).toBe("For 8 hours");
  radios()[2]!.focus();
  radios()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await flush();
  // Down wraps to the first row; the details close with their row.
  expect(value()).toBe("all");
  expect(document.activeElement).toBe(radios()[0]!);
  expect(details()).toBeNull();
  radios()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  await flush();
  expect(value()).toBe("off");
  expect(document.activeElement).toBe(radios()[2]!);
  expect(committed).toEqual(["off", "all", "off"]);
  dispose();
  dom.cleanup();
});

test("options rebuilt with new objects keep their rows and the focus on the chosen one", async () => {
  const dom = createDomTestHarness();
  // Each test has its own document; Solid's delegated handlers are registered per document.
  delegateEvents(["click", "keydown"], dom.document);
  const { ChoiceList } = await import("../src/inputs/ChoiceList");
  const [value, setValue] = createSignal<string | null>("all");
  const dispose = render(
    () =>
      createComponent(ChoiceList, {
        "aria-label": "Level",
        // A caller that maps its options inline hands over new objects whenever the value changes.
        get options() {
          return ["all", "off"].map((option) => ({
            value: option,
            label: option === "all" ? "All" : "Off",
            marker: value() === option ? "Now" : undefined,
          }));
        },
        value,
        onValueChange: setValue,
      }),
    dom.root,
  );
  const radios = () => Array.from(dom.root.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const first = radios()[0]!;
  first.focus();
  first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  await flush();
  expect(value()).toBe("off");
  expect(radios()[0]).toBe(first);
  expect(document.activeElement).toBe(radios()[1]!);
  expect(radios()[1]!.textContent).toContain("Now");
  dispose();
  dom.cleanup();
});
