import { describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../ui/test/dom";

describe("Spaces search form", () => {
  if (isServer) {
    test.skip("runs with browser conditions", () => {});
    return;
  }

  test("preserves GET filters and submits the focused draft immediately without a second debounced request", async () => {
    const dom = createDomTestHarness();
    const { default: SearchInput } = await import("../src/frontend/[id]/_components/filter/SearchInput");
    const searches: string[] = [];
    const dispose = render(
      () =>
        createComponent(SearchInput, {
          value: "initial",
          baseUrl: "/app/spaces/Space1?view=table&status=all&tag=one&tag=two&q=initial&page=3&item=Item1",
          debounceMs: 30,
          onSearch: (value) => {
            searches.push(value);
          },
        }),
      dom.root,
    );
    try {
      const form = dom.root.querySelector<HTMLFormElement>("form")!;
      const input = form.querySelector<HTMLInputElement>('input[name="q"]')!;
      expect(form.getAttribute("method")).toBe("get");
      expect(form.getAttribute("action")).toBe("/app/spaces/Space1");
      const fields = Array.from(form.querySelectorAll<HTMLInputElement>("input"), (field) => [field.name, field.value]);
      expect(fields).toEqual([
        ["q", "initial"],
        ["view", "table"],
        ["status", "all"],
        ["tag", "one"],
        ["tag", "two"],
        ["item", "Item1"],
      ]);
      input.focus();
      input.value = "typed draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const submit = new Event("submit", { bubbles: true, cancelable: true });
      form.dispatchEvent(submit);
      expect(submit.defaultPrevented).toBe(true);
      expect(searches).toEqual(["typed draft"]);
      expect(document.activeElement).toBe(input);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(searches).toEqual(["typed draft"]);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
});
