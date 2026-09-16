import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
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

test("explicit anchor navigation cancels pending and later follow-latest without requiring focus", async () => {
  const dom = createDomTestHarness();
  const { ChatTimeline } = await import("../src/chat/ChatTimeline");
  const [count, setCount] = createSignal(1);
  let viewport!: HTMLDivElement;
  let scrollToAnchor!: (anchorId: string | number) => boolean;
  const dispose = render(
    () => (
      <ChatTimeline
        scrollToAnchorRef={(navigate) => {
          scrollToAnchor = navigate;
        }}
        items={Array.from({ length: count() }, (_, index) => ({
          kind: "message" as const,
          id: String(index),
          role: "user" as const,
          content: "Message",
          anchorId: index + 1,
        }))}
        viewportRef={(element) => {
          viewport = element;
          Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => count() * 500 });
          Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
        }}
      />
    ),
    dom.root,
  );
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  try {
    await frame();
    setCount(2);
    await Promise.resolve();
    expect(scrollToAnchor("missing")).toBe(false);
    const anchor = dom.root.querySelector<HTMLElement>('[data-chat-anchor="1"]')!;
    Object.defineProperty(anchor, "getBoundingClientRect", { value: () => ({ top: -viewport.scrollTop + 16 }) });
    expect(scrollToAnchor(1)).toBe(true);
    await frame();
    expect(viewport.scrollTop).toBe(0);
    setCount(3);
    await frame();
    expect(viewport.scrollTop).toBe(0);
    viewport.scrollTop = 1400;
    viewport.dispatchEvent(new Event("scroll"));
    setCount(4);
    await frame();
    expect(viewport.scrollTop).toBe(2000);
  } finally {
    dispose();
    dom.cleanup();
  }
});
