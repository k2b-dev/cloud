import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

test("hands SSR bottom alignment to normal scrolling before the first client paint", async () => {
  const dom = createDomTestHarness();
  const { ChatTimeline } = await import("../src/chat/ChatTimeline");
  const scrollWrites: { top: number; initializing: boolean }[] = [];
  const dispose = render(
    () => (
      <ChatTimeline
        items={[
          { kind: "message", id: "first", role: "user", content: "First" },
          { kind: "message", id: "last", role: "assistant", content: "Last" },
        ]}
        viewportRef={(viewport) => {
          let top = 0;
          Object.defineProperty(viewport, "scrollHeight", { get: () => 1400 });
          Object.defineProperty(viewport, "scrollTop", {
            get: () => top,
            set: (value: number) => {
              top = value;
              scrollWrites.push({ top, initializing: viewport.hasAttribute("data-initializing") });
            },
          });
        }}
      />
    ),
    dom.root,
  );
  try {
    await Promise.resolve();
    expect(scrollWrites.length).toBeGreaterThan(0);
    expect(scrollWrites.every((write) => write.top === 1400 && !write.initializing)).toBe(true);
    const viewport = dom.root.querySelector(".k2b-chat-timeline__viewport");
    expect(viewport?.hasAttribute("data-initializing")).toBe(false);
    expect(dom.root.textContent?.indexOf("First")).toBeLessThan(dom.root.textContent?.indexOf("Last") ?? -1);
  } finally {
    dispose();
    dom.cleanup();
  }
});
