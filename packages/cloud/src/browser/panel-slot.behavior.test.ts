import { afterEach, expect, jest, test } from "bun:test";
import { createDomTestHarness } from "../../../ui/test/dom";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  const bootstrap = createDomTestHarness();
  const { handlePanelRequest, installPanelSlot, PANEL_READY_TIMEOUT_MS } = await import("./panel-slot");
  const { default: PanelTrigger } = await import("../ssr/PanelTrigger");
  bootstrap.cleanup();

  let cleanup = () => {};
  afterEach(() => {
    cleanup();
    jest.useRealTimers();
  });
  function setup(viewport = 1440, initialOpen = false, storedWidth = true) {
    const dom = createDomTestHarness();
    dom.window.innerWidth = viewport;
    document.documentElement.style.fontSize = "16px";
    const providers = ["fixture", "second"].map((id) => ({ id, label: `${id} panel`, icon: "ti ti-box", href: `/app/${id}/panel?base=1` }));
    dom.root.innerHTML = `<script id="cloud-shell-data" type="application/json">${JSON.stringify({ panel: { providers, provider: "fixture" } })}</script>
    <button id="opener" data-cloud-panel-toggle>Panel</button>
    <div class="cloud-app-canvas" ${initialOpen ? 'data-panel="open"' : ""} style="${storedWidth ? "--cloud-panel-width-set:24rem" : ""}">
      <div data-cloud-app-area><main class="layout-content-main">Application</main></div>
      <aside id="cloud-panel" data-provider="fixture" data-state="closed">
        <div class="cloud-panel__resize" aria-orientation="vertical" tabindex="0"></div>
        <button data-cloud-panel-close>Close</button><button data-cloud-panel-grow>Grow</button>
        <button data-cloud-panel-provider="fixture">Fixture</button><button data-cloud-panel-provider="second">Second</button>
        <div class="cloud-panel__body">${initialOpen ? '<iframe src="/app/fixture/panel?base=1" data-cloud-panel-frame="fixture"></iframe>' : ""}<button data-cloud-panel-retry>Try again</button><div class="k2b-placeholder__description"></div></div>
        <div data-cloud-panel-status></div>
      </aside>
    </div>`;
    Object.defineProperty(document.getElementById("cloud-panel"), "getBoundingClientRect", {
      value: () => ({ width: dom.window.innerWidth < 1280 ? 344 : 416 }),
    });
    const serverFrame = document.querySelector<HTMLIFrameElement>("iframe");
    const dispose = installPanelSlot();
    cleanup = () => {
      dispose();
      dom.cleanup();
    };
    const canvas = document.querySelector<HTMLElement>(".cloud-app-canvas")!;
    const slot = document.getElementById("cloud-panel")!;
    const opener = document.getElementById("opener")!;
    // Happy DOM has no layout; supply the opener's rendered rectangle explicitly.
    Object.defineProperty(opener, "getClientRects", { value: () => [{ width: 40, height: 24 }] });
    opener.focus();
    const frame = () => slot.querySelector<HTMLIFrameElement>("iframe")!;
    const open = (provider = "fixture", search?: string) => handlePanelRequest({ action: "open", provider, search, accepted: true });
    const message = (data: unknown, source = frame().contentWindow, origin = location.origin) => {
      const event = new Event("message");
      Object.defineProperties(event, { data: { value: data }, source: { value: source }, origin: { value: origin } });
      window.dispatchEvent(event);
    };
    const click = (selector: string) => slot.querySelector<HTMLButtonElement>(selector)!.click();
    const resize = (width: number) => {
      dom.window.innerWidth = width;
      dom.window.dispatchEvent(new dom.window.Event("resize"));
    };
    return { dom, canvas, slot, opener, frame, open, message, click, resize, dispose, serverFrame };
  }

  test("accepts only the current iframe, same origin and exact message schema", () => {
    const h = setup();
    h.open();
    const ready = { type: "cloud.panel.ready", v: 1, provider: "fixture" };
    h.message(ready, null);
    h.message(ready, h.frame().contentWindow, "https://elsewhere.test");
    h.message({ ...ready, provider: "second" });
    h.message({ ...ready, extra: true });
    h.message({ ...ready, v: 2 });
    h.message([ready]);
    expect(h.slot.dataset.state).toBe("loading");
    h.message(ready);
    expect(h.slot.dataset.state).toBe("ready");
    h.message({ type: "cloud.panel.close" }, null);
    h.message({ type: "cloud.panel.close" }, h.frame().contentWindow, "https://elsewhere.test");
    h.message({ type: "cloud.panel.close", extra: true });
    expect(h.canvas.dataset.panel).toBe("open");
    h.message({ type: "cloud.panel.close", v: 1 });
    expect(h.canvas.dataset.panel).toBeUndefined();
    expect(h.slot.querySelector("iframe")).toBeNull();
    expect(document.activeElement).toBe(h.opener);
  });

  test("times out at 10 s, retries with a fresh iframe, ignores the old frame and accepts late ready", () => {
    jest.useFakeTimers();
    const h = setup();
    h.open();
    const oldFrame = h.frame();
    const oldSource = oldFrame.contentWindow;
    jest.advanceTimersByTime(PANEL_READY_TIMEOUT_MS - 1);
    expect(h.slot.dataset.state).toBe("loading");
    jest.advanceTimersByTime(1);
    expect(h.slot.dataset.state).toBe("failed");
    expect(h.slot.querySelector("[data-cloud-panel-status]")?.textContent).toContain("fixture panel is not responding");
    h.click("[data-cloud-panel-retry]");
    expect(h.frame()).not.toBe(oldFrame);
    expect(h.slot.dataset.state).toBe("loading");
    h.message({ type: "cloud.panel.ready", v: 1, provider: "fixture" }, oldSource);
    expect(h.slot.dataset.state).toBe("loading");
    jest.advanceTimersByTime(PANEL_READY_TIMEOUT_MS);
    expect(h.slot.dataset.state).toBe("failed");
    h.message({ type: "cloud.panel.ready", v: 1, provider: "fixture" });
    expect(h.slot.dataset.state).toBe("ready");
    expect(h.slot.querySelector("[data-cloud-panel-status]")?.textContent).toBe("");
  });

  for (const viewport of [390, 767, 768, 834, 1440])
    test(`toggle uses the correct flag and writes cookies only from 768 px (${viewport})`, () => {
      const h = setup(viewport);
      handlePanelRequest({ action: "toggle" });
      const attribute = viewport < 768 ? "panelSheet" : "panel";
      expect(h.canvas.dataset[attribute]).toBe("open");
      expect(h.opener.getAttribute("aria-expanded")).toBe("true");
      expect(document.cookie).toBe(viewport < 768 ? "" : "cloud_panel=1:fixture:24");
      handlePanelRequest({ action: "toggle" });
      expect(h.canvas.dataset[attribute]).toBeUndefined();
      expect(h.opener.getAttribute("aria-expanded")).toBe("false");
      expect(document.cookie).toBe(viewport < 768 ? "" : "cloud_panel=0:fixture:24");
    });

  test("mode transitions keep independent flags and history only clears the phone sheet", () => {
    const h = setup();
    h.open();
    h.resize(390);
    expect(h.canvas.dataset.panel).toBe("open");
    expect(h.slot.dataset.state).toBe("closed");
    h.open();
    expect(h.canvas.dataset.panelSheet).toBe("open");
    expect(document.cookie).toBe("cloud_panel=1:fixture:24");
    window.dispatchEvent(new Event("popstate"));
    expect(h.canvas.dataset.panelSheet).toBeUndefined();
    h.open();
    const pageShow = Object.assign(new Event("pageshow"), { persisted: true });
    window.dispatchEvent(pageShow);
    expect(h.canvas.dataset.panelSheet).toBeUndefined();
    h.resize(834);
    expect(h.slot.dataset.state).toBe("loading");
    expect(h.canvas.dataset.panel).toBe("open");
  });

  test("invalid providers change nothing, search replaces the query and switching unloads", () => {
    const h = setup();
    h.open("unknown");
    expect(h.slot.querySelector("iframe")).toBeNull();
    h.open("fixture", "?q=hello");
    const old = h.frame();
    expect(old.getAttribute("src")).toBe("/app/fixture/panel?q=hello");
    h.open("second");
    expect(old.isConnected).toBe(false);
    expect(h.slot.querySelectorAll("iframe")).toHaveLength(1);
    expect(h.frame().getAttribute("src")).toBe("/app/second/panel?base=1");
    expect(h.slot.querySelector(".k2b-placeholder__description")?.textContent).toContain("second panel");
  });

  test("close falls back to Main when the opener disappears, and removes its temporary tabindex on blur", () => {
    const h = setup();
    h.open();
    h.opener.remove();
    handlePanelRequest({ action: "close" });
    const main = document.querySelector("main")!;
    expect(document.activeElement).toBe(main);
    expect(main.getAttribute("tabindex")).toBe("-1");
    main.blur();
    expect(main.hasAttribute("tabindex")).toBe(false);
  });

  test("tabs move focus manually, Escape respects prevention, and grabber toggles size", () => {
    const h = setup(390);
    h.open();
    const tabs = h.slot.querySelectorAll<HTMLButtonElement>("[data-cloud-panel-provider]");
    tabs[0]!.focus();
    tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(tabs[1]!);
    expect(h.slot.dataset.provider).toBe("fixture");
    h.click("[data-cloud-panel-provider='second']");
    expect(h.slot.dataset.provider).toBe("second");
    h.click("[data-cloud-panel-grow]");
    expect(h.slot.dataset.panelSize).toBe("full");
    expect(h.slot.querySelector("[data-cloud-panel-grow]")?.getAttribute("aria-label")).toBe("Shrink panel");
    h.click("[data-cloud-panel-grow]");
    expect(h.slot.dataset.panelSize).toBeUndefined();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();
    tabs[1]!.dispatchEvent(event);
    expect(h.canvas.dataset.panelSheet).toBe("open");
    tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(h.canvas.dataset.panelSheet).toBeUndefined();
  });

  test("install is idempotent and disposal removes the timer and listeners", () => {
    jest.useFakeTimers();
    const h = setup();
    expect(installPanelSlot()).toBe(h.dispose);
    h.open();
    h.dispose();
    jest.advanceTimersByTime(PANEL_READY_TIMEOUT_MS);
    expect(h.slot.dataset.state).toBe("loading");
    h.click("[data-cloud-panel-close]");
    expect(h.canvas.dataset.panel).toBe("open");
  });

  test("rem resize keys commit, close-drag retains width, and cancellation restores the original size", () => {
    const h = setup();
    h.open();
    const separator = h.slot.querySelector<HTMLElement>(".cloud-panel__resize")!;
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true }));
    expect(separator.getAttribute("aria-valuenow")).toBe("25");
    expect(document.cookie).toBe("cloud_panel=1:fixture:25");
    const pointer = (type: string, clientX: number) =>
      separator.dispatchEvent(
        Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
          button: 0,
          isPrimary: true,
          pointerId: 1,
          clientX,
        }),
      );
    pointer("pointerdown", 0);
    pointer("pointermove", 160);
    expect(h.slot.dataset.resizing).toBe("true");
    expect(h.slot.dataset.closing).toBe("true");
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("20rem");
    pointer("pointerup", 160);
    expect(h.slot.dataset.state).toBe("closed");
    expect(document.cookie).toBe("cloud_panel=0:fixture:25");
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("25rem");
    h.open();
    pointer("pointerdown", 0);
    pointer("pointermove", -32);
    pointer("pointercancel", -32);
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("25rem");
    expect(document.cookie).toBe("cloud_panel=1:fixture:25");
    expect(h.slot.dataset.resizing).toBeUndefined();
    pointer("pointerdown", 0);
    pointer("pointermove", -32);
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(h.slot.dataset.resizing).toBeUndefined();
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("25rem");
    expect(document.cookie).toBe("cloud_panel=0:fixture:25");
  });

  test("drawer mode has no resize behavior, including after a column mode change", () => {
    const h = setup(834);
    h.open();
    const separator = h.slot.querySelector<HTMLElement>(".cloud-panel__resize")!;
    const key = () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true }));
    key();
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("24rem");
    h.resize(1440);
    key();
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("25rem");
    h.resize(834);
    key();
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("25rem");
  });

  for (const viewport of [390, 1440])
    test(`late trigger mounting uses current slot state instead of stale SSR props (${viewport})`, () => {
      const h = setup(viewport);
      h.open();
      const root = document.createElement("div");
      h.dom.root.append(root);
      const dispose = render(() => createComponent(PanelTrigger, { variant: "header", open: false }), root);
      try {
        expect(root.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
      } finally {
        dispose();
      }
    });

  test("SSR-open restarts the iframe after installing its listener, so an earlier ready cannot be lost", () => {
    const h = setup(1440, true);
    expect(h.serverFrame).not.toBeNull();
    expect(h.serverFrame?.isConnected).toBe(false);
    expect(h.frame()).not.toBe(h.serverFrame);
    expect(h.slot.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.cookie).toBe("");
    h.message({ type: "cloud.panel.ready", v: 1, provider: "fixture" });
    expect(h.slot.dataset.state).toBe("ready");
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("24rem");
  });

  test("without a stored width, viewport resize keeps ARIA and the next key step on the CSS default", () => {
    const h = setup(1440, false, false);
    h.open();
    const separator = h.slot.querySelector<HTMLElement>(".cloud-panel__resize")!;
    expect(separator.getAttribute("aria-valuenow")).toBe("26");
    h.resize(1194);
    expect(separator.getAttribute("aria-valuenow")).toBe("21.5");
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("");
    separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true }));
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("22.5rem");
    expect(document.cookie).toBe("cloud_panel=1:fixture:22.5");
  });
}
