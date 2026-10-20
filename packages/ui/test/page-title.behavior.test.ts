import { expect, test } from "bun:test";
import { isServer } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  test("the document trail follower disposes removed titles while connected titles keep updating", async () => {
    const dom = createDomTestHarness();
    const { followPageTrail, setPageTrail } = await import("../src/layout/PageTitle");
    const row = () => {
      const element = document.createElement("header");
      element.innerHTML =
        '<div class="k2b-page-title" data-k2b-server><h1 class="k2b-page-title__title"><span class="k2b-page-title__text">Server title</span></h1></div>';
      return element;
    };
    const removed = row();
    const retained = row();
    dom.root.append(removed, retained);
    const dispose = followPageTrail(document);
    const title = (row: HTMLElement) => row.querySelector(".k2b-page-title__text")?.textContent;
    try {
      setPageTrail({ title: "First", ancestors: [] });
      expect(title(removed)).toBe("First");
      expect(title(retained)).toBe("First");
      removed.remove();
      setPageTrail({ title: "Second", ancestors: [] });
      expect(title(removed)).not.toBe("Second");
      expect(title(retained)).toBe("Second");
      setPageTrail({ title: "Third", ancestors: [] });
      expect(title(removed)).not.toBe("Third");
      expect(title(retained)).toBe("Third");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}
