import { expect, test } from "bun:test";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

// Load once outside any test, so the cold Solid transform of the library source does not count against the test
// timeout. The library needs a document while its modules evaluate.
const load = async () => {
  const dom = createDomTestHarness();
  try {
    return (await import("../src/v2")).Input;
  } finally {
    dom.cleanup();
  }
};
const Input = await load();

// Without CSS `field-sizing` (this test DOM has none), a text of several lines fits its height to its words in a
// microtask after its value changes. A field that leaves before that microtask runs is not measured any more: a page
// that goes away at once (a test that ends, a dialog that closes on save) would otherwise reach a document that is gone.
test("a text of several lines that leaves before its height is fitted is not measured any more", async () => {
  const dom = createDomTestHarness();
  const [value, setValue] = createSignal("first line");
  const dispose = render(() => <Input multiline value={value()} />, dom.root);
  try {
    const area = dom.root.querySelector("textarea")!;
    await Bun.sleep(0);
    area.style.height = "";
    setValue("first line\nsecond line");
    dispose();
    await Bun.sleep(0);
    expect(area.style.height).toBe("");
  } finally {
    dom.cleanup();
  }
});

test("a text of several lines that stays fits its height after its value changes", async () => {
  const dom = createDomTestHarness();
  const [value, setValue] = createSignal("first line");
  const dispose = render(() => <Input multiline value={value()} />, dom.root);
  try {
    const area = dom.root.querySelector("textarea")!;
    await Bun.sleep(0);
    area.style.height = "";
    setValue("first line\nsecond line");
    await Bun.sleep(0);
    expect(area.style.height).toMatch(/^\d+px$/);
  } finally {
    dispose();
    dom.cleanup();
  }
});
