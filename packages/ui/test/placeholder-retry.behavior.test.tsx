import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("Try again invokes the owner's recovery without replacing its action", async () => {
    const dom = createDomTestHarness();
    const { default: Placeholder } = await import("../src/surfaces/Placeholder");
    let retries = 0;
    const dispose = render(
      () =>
        createComponent(Placeholder, {
          state: "error",
          action: "Keep selection",
          onRetry: () => {
            retries++;
          },
        }),
      dom.root,
    );
    try {
      const button = dom.root.querySelector("button");
      expect(button?.textContent).toBe("Try again");
      button?.click();
      expect(retries).toBe(1);
      expect(dom.root.textContent).toContain("Keep selection");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
