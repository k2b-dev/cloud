import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "./dom";

if (isServer) test.skip("requires browser conditions", () => {});
else
  test("shared scroll fade follows both edges, content changes and reactive opt-out", async () => {
    const dom = createDomTestHarness();
    const { default: AppWorkspace } = await import("../src/layout/AppWorkspace");
    const { default: DetailPanel } = await import("../src/layout/DetailPanel");
    const { default: ScrollArea } = await import("../src/layout/ScrollArea");
    try {
      for (const Component of [AppWorkspace.SidebarBody, DetailPanel.Body, ScrollArea]) {
        const [enabled, setEnabled] = createSignal<boolean | undefined>(undefined);
        const dispose = render(
          () =>
            createComponent(Component, {
              children: "Content",
              get scrollFade() {
                return enabled();
              },
            }),
          dom.root,
        );
        const body = dom.root.firstElementChild as HTMLElement;
        Object.defineProperties(body, { scrollHeight: { configurable: true, value: 500 }, clientHeight: { value: 200 } });
        const scroll = (top: number) => {
          body.scrollTop = top;
          body.dispatchEvent(new dom.window.Event("scroll"));
        };
        scroll(0);
        expect(body.dataset.scrollFade).toBe("bottom");
        setEnabled(true);
        scroll(100);
        expect(body.dataset.scrollFade).toBe("both");
        scroll(300);
        expect(body.dataset.scrollFade).toBe("top");
        setEnabled(false);
        scroll(100);
        expect(body.dataset.scrollFade).toBeUndefined();
        setEnabled(true);
        expect(body.dataset.scrollFade).toBe("both");
        Object.defineProperty(body, "scrollHeight", { value: 200 });
        body.textContent = "Short content";
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(body.dataset.scrollFade).toBeUndefined();
        dispose();
      }
    } finally {
      dom.cleanup();
    }
  });

if (!isServer)
  test("SSR scrollports survive shared controller ownership and navigation", async () => {
    const dom = createDomTestHarness();
    const { installScrollFades } = await import("../src/layout/scroll-fade");
    dom.root.innerHTML = '<div data-scroll-fade-mode="both"></div><div class="unmanaged"></div>';
    const port = dom.root.firstElementChild as HTMLElement;
    Object.defineProperties(port, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
    const first = installScrollFades(dom.root),
      second = installScrollFades(dom.root);
    try {
      expect(port.dataset.scrollFade).toBe("bottom");
      first();
      port.scrollTop = 100;
      port.dispatchEvent(new dom.window.Event("scroll"));
      expect(port.dataset.scrollFade).toBe("both");
      const next = dom.document.createElement("div");
      next.setAttribute("data-scroll-fade-mode", "bottom");
      Object.defineProperties(next, { scrollHeight: { value: 500 }, clientHeight: { value: 100 } });
      dom.root.append(next);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(next.getAttribute("data-scroll-fade")).toBe("bottom");
      expect(dom.root.querySelector(".unmanaged")?.hasAttribute("data-scroll-fade")).toBe(false);
      second();
      expect(port.dataset.scrollFade).toBeUndefined();
      expect(next.getAttribute("data-scroll-fade")).toBeNull();
    } finally {
      dom.cleanup();
    }
  });

if (!isServer)
  test("workspace marks only the actual main scroll owners", async () => {
    const dom = createDomTestHarness();
    const { default: Workspace } = await import("../src/layout/AppWorkspace");
    const [scroll, setScroll] = createSignal(true);
    const dispose = render(
      () => (
        <Workspace.Main scroll={scroll()}>
          <div>Primary</div>
          <Workspace.MainPane id="preview" label="Preview" scroll={scroll()}>
            Preview
          </Workspace.MainPane>
        </Workspace.Main>
      ),
      dom.root,
    );
    try {
      expect(dom.root.querySelector(".k2b-app-workspace__main")?.hasAttribute("data-scroll-fade-mode")).toBe(false);
      expect(dom.root.querySelector(".k2b-app-workspace__main-primary")?.hasAttribute("data-scroll-fade-mode")).toBe(false);
      expect(dom.root.querySelector(".k2b-app-workspace__main-pane")?.getAttribute("data-scroll-fade-mode")).toBe("both");
      setScroll(false);
      expect(dom.root.querySelector(".k2b-app-workspace__main-pane")?.hasAttribute("data-scroll-fade-mode")).toBe(false);
    } finally {
      dispose();
      dom.cleanup();
    }
  });
