import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// Load once outside any test, so the cold Solid transform of the library source does not count against the 5 s test
// timeout. The library needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("../src")).TextInput;
  } finally {
    dom.cleanup();
  }
};
const TextInput = await load();

test("Enter submits a single-line TextInput without submitting a surrounding form twice", async () => {
  const dom = createDomTestHarness();
  const [value, setValue] = createSignal("");
  let submitted = 0;
  const dispose = render(() => <TextInput label="Search" value={value} onValueChange={setValue} onSubmit={() => submitted++} />, dom.root);
  const input = dom.root.querySelector("input")!;
  input.value = "report";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(value()).toBe("report");
  const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
  input.dispatchEvent(enter);
  expect(submitted).toBe(1);
  expect(enter.defaultPrevented).toBeTrue();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  expect(submitted).toBe(1);
  dispose();
  dom.cleanup();
});
