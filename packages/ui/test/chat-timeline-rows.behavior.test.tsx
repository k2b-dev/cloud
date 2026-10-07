import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("an updated record with the same id keeps its row, content and state", async () => {
    const dom = createDomTestHarness();
    const { ChatTimeline } = await import("../src/chat/ChatTimeline");
    type Item = import("../src/chat/ChatTimeline").ChatTimelineItem;
    const content = document.createElement("section");
    content.textContent = "Running view";
    const [items, setItems] = createSignal<Item[]>([
      { kind: "message", id: "question", role: "user", content: "Build it" },
      { kind: "message", id: "answer", role: "assistant", status: "streaming", content },
    ]);
    const dispose = render(
      () =>
        createComponent(ChatTimeline, {
          get items() {
            return items();
          },
        }),
      dom.root,
    );
    try {
      const article = dom.root.querySelector('[data-role="assistant"]');
      expect(article?.getAttribute("data-status")).toBe("streaming");
      // A new record object for the same id, as a live turn becoming history produces.
      setItems((current) => [
        current[0]!,
        {
          kind: "message",
          id: "answer",
          role: "assistant",
          content,
          actions: [{ id: "copy", label: "Copy", copyText: "Done" }],
        },
      ]);
      expect(dom.root.querySelector('[data-role="assistant"]')).toBe(article);
      expect(article?.getAttribute("data-status")).toBe("complete");
      expect(article?.contains(content)).toBe(true);
      expect(article?.querySelector('button[aria-label="Copy"]')).not.toBeNull();
      setItems((current) => [current[1]!]);
      expect(dom.root.querySelector('[data-role="assistant"]')).toBe(article);
      expect(dom.root.querySelector('[data-role="user"]')).toBeNull();
    } finally {
      dispose();
      dom.cleanup();
    }
  });
