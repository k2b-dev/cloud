import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";

// Every island carries `IslandError`; its view loads only when an island fails. Once loaded it is the v2 `Failed`
// state in the page's language, and "Retry" remounts the island.
test("a failed island shows its Failed state in the page's language once its view arrives, and Retry remounts it", async () => {
  const dom = createDomTestHarness();
  try {
    dom.window.document.documentElement.lang = "de";
    const { default: IslandError } = await import("./IslandError");
    let resets = 0;
    const dispose = render(
      () =>
        createComponent(IslandError, {
          error: new Error("Fixture failure"),
          reset: () => {
            resets += 1;
          },
        }),
      dom.root,
    );
    // the view is a module of its own: once it is there, the fallback shows it
    await import("./IslandErrorView");
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
    expect(dom.root.textContent).toContain("Dieser Bereich konnte nicht angezeigt werden.");
    const retry = dom.root.querySelector("button");
    expect(retry).not.toBeNull();
    retry!.click();
    expect(resets).toBe(1);
    dispose();
  } finally {
    dom.cleanup();
  }
});
