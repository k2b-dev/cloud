import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("tool details render only on expansion and survive title updates", async () => {
    const dom = createDomTestHarness();
    const { ChatActivity } = await import("../src/chat/ChatPrimitives");
    const [title, setTitle] = createSignal("Reading");
    let renders = 0;
    const dispose = render(
      () =>
        createComponent(ChatActivity, {
          get label() {
            return title();
          },
          renderBody: () => {
            renders++;
            return "Large diagnostic output";
          },
        }),
      dom.root,
    );
    try {
      const details = dom.root.querySelector("details")!;
      expect(renders).toBe(0);
      details.open = true;
      details.dispatchEvent(new Event("toggle"));
      expect(renders).toBe(1);
      expect(dom.root.textContent).toContain("Large diagnostic output");
      setTitle("Read files");
      expect(dom.root.textContent).toContain("Read files");
      expect(dom.root.querySelector("details")).toBe(details);
      expect(details.open).toBe(true);
      expect(renders).toBe(1);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
