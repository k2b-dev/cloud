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
    const { default: PanelDialog } = await import("../src/layout/PanelDialog");
    const { default: ScrollArea } = await import("../src/layout/ScrollArea");
    try {
      for (const Component of [AppWorkspace.SidebarBody, DetailPanel.Body, ScrollArea, PanelDialog.Body]) {
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
          body.dispatchEvent(new Event("scroll"));
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
      port.dispatchEvent(new Event("scroll"));
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

if (!isServer)
  test("horizontal fades follow physical edges in LTR and RTL, reactive axis and content changes", async () => {
    const dom = createDomTestHarness();
    const { default: ScrollArea } = await import("../src/layout/ScrollArea");
    const [orientation, setOrientation] = createSignal<"vertical" | "horizontal">("horizontal");
    const dispose = render(() => <ScrollArea orientation={orientation()}>Wide content</ScrollArea>, dom.root);
    try {
      const body = dom.root.firstElementChild as HTMLElement;
      Object.defineProperties(body, {
        scrollWidth: { configurable: true, value: 500 },
        clientWidth: { value: 200 },
        scrollHeight: { value: 200 },
        clientHeight: { value: 200 },
      });
      const scroll = (left: number) => {
        body.scrollLeft = left;
        body.dispatchEvent(new Event("scroll"));
      };
      scroll(0);
      expect(body.dataset.scrollFade, "initial horizontal").toBe("bottom");
      scroll(120);
      expect(body.dataset.scrollFade).toBe("both");
      scroll(300);
      expect(body.dataset.scrollFade).toBe("top");
      body.style.direction = "rtl";
      scroll(0);
      expect(body.dataset.scrollFade).toBe("top");
      scroll(-120);
      expect(body.dataset.scrollFade).toBe("both");
      scroll(-300);
      expect(body.dataset.scrollFade, "rtl end").toBe("bottom");
      setOrientation("vertical");
      await Promise.resolve();
      expect(body.dataset.scrollFade).toBeUndefined();
      setOrientation("horizontal");
      await Promise.resolve();
      expect(body.dataset.scrollFade, "after axis restored").toBe("bottom");
      Object.defineProperty(body, "scrollWidth", { value: 200 });
      body.textContent = "Short";
      await Promise.resolve();
      expect(body.dataset.scrollFade).toBeUndefined();
    } finally {
      dispose();
      dom.cleanup();
    }
  });

if (!isServer)
  test("tabs use their existing horizontal scrollport and disable fades vertically", async () => {
    const dom = createDomTestHarness();
    const { Tabs } = await import("../src/actions/Tabs");
    const [orientation, setOrientation] = createSignal<"vertical" | "horizontal">("horizontal");
    const dispose = render(
      () => (
        <Tabs
          value="one"
          onValueChange={() => {}}
          ariaLabel="Views"
          orientation={orientation()}
          options={[
            { value: "one", label: "One" },
            { value: "two", label: "Two" },
          ]}
        />
      ),
      dom.root,
    );
    try {
      const list = dom.root.querySelector<HTMLElement>('[role="tablist"]')!;
      Object.defineProperties(list, { scrollWidth: { value: 500 }, clientWidth: { value: 100 } });
      list.dispatchEvent(new Event("scroll"));
      expect(list.dataset.scrollFade).toBe("bottom");
      expect(dom.root.querySelectorAll("[data-scroll-fade-mode]").length).toBe(1);
      setOrientation("vertical");
      expect(list.dataset.scrollFade).toBeUndefined();
    } finally {
      dispose();
      dom.cleanup();
    }
  });

test("forced colors remove both vertical and horizontal masks", async () => {
  const css = await Bun.file(new URL("../src/styles/index.css", import.meta.url)).text();
  const forcedColors = css.slice(css.indexOf("@media (forced-colors: active)", css.indexOf("--scroll-fade-size: 1rem")));
  expect(forcedColors).toContain('.k2b-ui [data-scroll-fade][data-scroll-fade-axis="horizontal"] { mask-image: none; }');
});

if (!isServer) test("compact viewport remains mounted across catalog states and is opt-in", async () => {
  const dom = createDomTestHarness();
  const { default: ScrollArea } = await import("../src/layout/ScrollArea");
  const [size, setSize] = createSignal<"compact" | undefined>(undefined);
  const [content, setContent] = createSignal("Loading");
  const dispose = render(() => <ScrollArea viewportSize={size()}>{content()}</ScrollArea>, dom.root);
  try {
    const viewport = dom.root.firstElementChild!;
    expect(viewport.hasAttribute("data-viewport-size")).toBe(false);
    setSize("compact");
    for (const state of ["Empty", "Failed", "Results"]) {
      setContent(state);
      expect(dom.root.firstElementChild).toBe(viewport);
      expect(viewport.getAttribute("data-viewport-size")).toBe("compact");
      expect(viewport.textContent).toBe(state);
    }
    setSize(undefined);
    expect(viewport.hasAttribute("data-viewport-size")).toBe(false);
  } finally { dispose(); dom.cleanup(); }
});
