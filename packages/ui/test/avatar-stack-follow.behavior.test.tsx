import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("the open people list stays inside the window when the window narrows", async () => {
    const dom = createDomTestHarness();
    dom.window.happyDOM.setWindowSize({ width: 1440, height: 900 });
    const { AvatarStack } = await import("../src/surfaces/AvatarStack");
    const rect = (x: number, width: number, height: number) =>
      ({ x, y: 20, left: x, top: 20, right: x + width, bottom: 20 + height, width, height, toJSON: () => ({}) }) satisfies DOMRect;
    const dispose = render(
      () => <AvatarStack people={[{ id: "jana", name: "Jana Berger" }]} title="Here now" label="Here now" />,
      dom.root,
    );
    try {
      const trigger = dom.root.querySelector<HTMLButtonElement>(".k2b-avatar-stack__trigger")!;
      const popover = dom.root.querySelector<HTMLElement>(".k2b-avatar-stack__popover")!;
      // happy-dom has no popover API: open and close the way a browser does, with a toggle event.
      let shown = false;
      const toggleTo = (next: boolean) => {
        shown = next;
        const event = new Event("toggle");
        Object.defineProperty(event, "newState", { value: next ? "open" : "closed" });
        popover.dispatchEvent(event);
      };
      const matches = popover.matches.bind(popover);
      Object.defineProperty(popover, "matches", {
        value: (selector: string) => (selector === ":popover-open" ? shown : matches(selector)),
      });
      popover.showPopover = () => toggleTo(true);
      popover.hidePopover = () => toggleTo(false);
      // A trigger near the right edge of a wide window; the list is 280 px wide.
      trigger.getBoundingClientRect = () => rect(1300, 40, 24);
      popover.getBoundingClientRect = () => rect(0, 280, 200);
      trigger.click();
      await new Promise((done) => setTimeout(done, 20));
      expect(popover.style.left).toBe("1060px");

      // The window narrows and the trigger moves with the layout.
      trigger.getBoundingClientRect = () => rect(700, 40, 24);
      dom.window.happyDOM.setWindowSize({ width: 760, height: 900 });
      window.dispatchEvent(new Event("resize"));
      await new Promise((done) => setTimeout(done, 20));
      expect(popover.style.left).toBe("460px");

      // Closed, it no longer follows the window.
      popover.hidePopover();
      trigger.getBoundingClientRect = () => rect(300, 40, 24);
      window.dispatchEvent(new Event("resize"));
      await new Promise((done) => setTimeout(done, 20));
      expect(popover.style.left).toBe("460px");
    } finally {
      dispose();
      dom.cleanup();
    }
  });
