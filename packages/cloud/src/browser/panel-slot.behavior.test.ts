import { afterEach, expect, jest, mock, spyOn, test } from "bun:test";
import { createComponent } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import type { PanelConsentSnapshot, PanelPageContext } from "../contracts/panel-context";
import { isPanelContextMessage, PANEL_CONTEXT_PARAM } from "../contracts/panel-context-plain";
import { readShellData } from "../ssr/shell-data";
import { type ContextAwareCommand, registerContextAwareCommand } from "./command-bridge";

if (isServer) test.skip("requires browser conditions and solid-dom-preload", () => {});
else {
  const bootstrap = createDomTestHarness();
  const { COMMANDS_CHANGED } = await import("./command-shortcuts");
  const { handlePanelRequest, installPanelSlot, PANEL_READY_TIMEOUT_MS } = await import("./panel-slot");
  const { default: PanelTrigger } = await import("../ssr/PanelTrigger");
  bootstrap.cleanup();

  let cleanup = () => {};
  const commandDisposers: (() => void)[] = [];
  let fetchSpy: { mockRestore(): void } | undefined;
  afterEach(() => {
    commandDisposers.splice(0).forEach((dispose) => dispose());
    cleanup();
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    jest.useRealTimers();
  });
  function setup(
    viewport = 1440,
    initialOpen = false,
    storedWidth = true,
    beforeInstall?: (frame: HTMLIFrameElement) => void,
    navigationApi = false,
    href = (id: string) => `/app/${id}/panel?base=1`,
    contextOptions: {
      context: PanelPageContext | null;
      consent: boolean;
      answer?: boolean | null;
      restored?: boolean;
      providerIds?: [string, string];
    } = {
      context: null,
      consent: false,
    },
  ) {
    const dom = createDomTestHarness();
    const navigation = new dom.window.EventTarget();
    if (navigationApi) Object.defineProperty(dom.window, "navigation", { value: navigation });
    dom.window.innerWidth = viewport;
    document.documentElement.style.fontSize = "16px";
    const providerIds = contextOptions.providerIds ?? ["fixture", "second"];
    const initialProvider = providerIds[0];
    const providers = providerIds.map((id) => ({
      id,
      label: `${id} panel`,
      appName: id,
      consent: id === "core" ? false : contextOptions.consent,
      icon: "ti ti-box",
      href: href(id),
    }));
    dom.root.innerHTML = `<script id="cloud-shell-data" type="application/json">${JSON.stringify({ panel: { providers, provider: initialProvider, context: contextOptions.context, ...(Object.hasOwn(contextOptions, "answer") ? { consent: { provider: initialProvider, allowed: contextOptions.answer, revision: typeof contextOptions.answer === "boolean" ? 1 : 0 } } : {}) } })}</script>
    <button id="opener" data-cloud-panel-toggle>Panel</button>
    <div class="cloud-app-canvas" ${initialOpen ? 'data-panel="open"' : ""} style="${storedWidth ? "--cloud-panel-width-set:24rem" : ""}">
      <div data-cloud-app-area><main class="layout-content-main">Application</main></div>
      <aside id="cloud-panel" data-provider="${initialProvider}" data-state="closed">
        <div class="cloud-panel__resize" aria-orientation="vertical" tabindex="0"></div>
        <button data-cloud-panel-close>Close</button><button data-cloud-panel-grow>Grow</button>
        ${providerIds.map((id) => `<button data-cloud-panel-provider="${id}">${id}</button>`).join("")}<span data-cloud-panel-menu><button>Placeholder</button></span>
        <div class="cloud-panel__body"><div data-cloud-panel-consent tabindex="-1"><h3 data-cloud-panel-consent-title></h3><p data-cloud-panel-consent-body></p><button data-cloud-panel-consent-answer="allow">Allow</button><button data-cloud-panel-consent-answer="deny">Deny</button><p data-cloud-panel-consent-error></p></div>${initialOpen ? `<iframe src="${href(initialProvider)}" data-cloud-panel-frame="${initialProvider}"></iframe>` : ""}<button data-cloud-panel-retry>Try again</button><div class="k2b-placeholder__description"></div></div>
        <div data-cloud-panel-status></div>
      </aside>
    </div>`;
    Object.defineProperty(document.getElementById("cloud-panel"), "getBoundingClientRect", {
      value: () => ({ width: dom.window.innerWidth < 1280 ? 344 : 416 }),
    });
    if (contextOptions.restored) document.documentElement.setAttribute("data-cloud-page-restored", "");
    const serverFrame = document.querySelector<HTMLIFrameElement>("iframe");
    if (serverFrame) beforeInstall?.(serverFrame);
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
    const open = (provider = initialProvider, search?: string) => handlePanelRequest({ action: "open", provider, search, accepted: true });
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
    return { dom, canvas, slot, opener, frame, open, message, click, resize, dispose, serverFrame, navigation };
  }

  for (const href of ["//elsewhere.test/panel", "https://elsewhere.test/panel", "javascript:alert(1)"])
    test(`never points the iframe off this origin: ${href}`, () => {
      const h = setup(1440, false, true, undefined, false, () => href);
      h.open();
      expect(h.slot.querySelector("iframe")).toBeNull();
    });
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

  test("search messages run the host command only from the current frame at the same origin", async () => {
    const h = setup();
    h.open();
    const action = mock(() => {});
    registerShortcut("cloud.search", "mod+k", { action });
    const search = { type: "cloud.panel.search", v: 1 };
    const oldSource = h.frame().contentWindow;
    h.open("second");
    h.message(search, oldSource);
    h.message(search, h.frame().contentWindow, "https://elsewhere.test");
    h.message({ ...search, extra: true });
    await tick();
    expect(action).not.toHaveBeenCalled();
    h.message(search);
    await tick();
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("search messages do nothing without a registered search shortcut or when it conflicts", async () => {
    const h = setup();
    h.open();
    const other = mock(() => {});
    registerShortcut("fixture.search", "mod+k", { action: other });
    const search = { type: "cloud.panel.search", v: 1 };
    h.message(search);
    await tick();
    expect(other).not.toHaveBeenCalled();
    const action = mock(() => {});
    const unregister = registerShortcut("cloud.search", "mod+k", { action });
    h.message(search);
    await tick();
    expect(action).not.toHaveBeenCalled();
    unregister();
    registerShortcut("cloud.search", "", { action });
    h.message(search);
    await tick();
    expect(action).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
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

  test("transient canvases open and close without changing the shared cookie", () => {
    const h = setup();
    h.canvas.setAttribute("data-panel-transient", "");
    document.cookie = "cloud_panel=1:second:30; Path=/";
    h.open();
    expect(h.canvas.dataset.panel).toBe("open");
    expect(document.cookie).toBe("cloud_panel=1:second:30");
    handlePanelRequest({ action: "close" });
    expect(h.canvas.dataset.panel).toBeUndefined();
    expect(document.cookie).toBe("cloud_panel=1:second:30");
  });

  test("in-page push navigation closes the phone sheet, while replace and traverse keep it", () => {
    const h = setup(390, false, true, undefined, true);
    h.open();
    const change = (navigationType: string) =>
      h.navigation.dispatchEvent(Object.assign(new h.dom.window.Event("currententrychange"), { navigationType }));
    change("replace");
    expect(h.canvas.dataset.panelSheet).toBe("open");
    change("traverse");
    expect(h.canvas.dataset.panelSheet).toBe("open");
    change("push");
    expect(h.canvas.dataset.panelSheet).toBeUndefined();
    expect(h.slot.querySelector("iframe")).toBeNull();
    expect(h.opener.getAttribute("aria-expanded")).toBe("false");
    h.open();
    h.dispose();
    change("push");
    expect(h.canvas.dataset.panelSheet).toBe("open");
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
    expect(old.getAttribute("src")).toBe(`${location.origin}/app/fixture/panel?q=hello`);
    h.open("second");
    expect(old.isConnected).toBe(false);
    expect(h.slot.querySelectorAll("iframe")).toHaveLength(1);
    expect(h.frame().getAttribute("src")).toBe(`${location.origin}/app/second/panel?base=1`);
    expect(h.slot.querySelector(".k2b-placeholder__description")?.textContent).toContain("second panel");
  });

  test("a requested search replaces a page reached inside the panel and keeps the page it already shows", () => {
    const h = setup();
    const show = (frame: HTMLIFrameElement, path: string) =>
      Object.defineProperty(frame, "contentWindow", { configurable: true, value: { location: { href: `${location.origin}${path}` } } });
    h.open("fixture", "q=bolts");
    const first = h.frame();
    show(first, "/app/fixture/panel/details?item=1");
    h.open("fixture", "q=bolts");
    expect(first.isConnected).toBe(false);
    const second = h.frame();
    expect(second.getAttribute("src")).toBe(`${location.origin}/app/fixture/panel?q=bolts`);
    show(second, "/app/fixture/panel?q=bolts");
    h.open("fixture", "q=bolts");
    expect(h.frame()).toBe(second);
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

  test("opening and closing keep a width another tab saved meanwhile", () => {
    const h = setup(1440);
    h.open();
    expect(document.cookie).toBe("cloud_panel=1:fixture:24");
    document.cookie = "cloud_panel=1:fixture:32; Path=/";
    handlePanelRequest({ action: "close" });
    expect(document.cookie).toBe("cloud_panel=0:fixture:32");
    // Reopening shows the width the cookie holds, also when close already adopted it.
    h.open();
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("32rem");
    expect(h.slot.querySelector(".cloud-panel__resize")?.getAttribute("aria-valuenow")).toBe("32");
    handlePanelRequest({ action: "close" });
    document.cookie = "cloud_panel=0:fixture:30; Path=/";
    h.open();
    expect(document.cookie).toBe("cloud_panel=1:fixture:30");
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("30rem");
  });

  test("SSR-open keeps the server iframe and still hears its later ready", () => {
    const h = setup(1440, true);
    if (!h.serverFrame) throw new Error("Expected an SSR iframe");
    expect(h.frame()).toBe(h.serverFrame);
    expect(h.slot.querySelectorAll("iframe")).toHaveLength(1);
    expect(h.slot.dataset.state).toBe("loading");
    expect(document.cookie).toBe("");
    h.message({ type: "cloud.panel.ready", v: 1, provider: "fixture" });
    expect(h.slot.dataset.state).toBe("ready");
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("24rem");
  });

  test("SSR-open reads the ready mark a provider set before the controller arrived", () => {
    const h = setup(1440, true, true, (frame) => {
      frame.contentDocument!.documentElement.dataset.cloudPanelReady = "fixture";
    });
    if (!h.serverFrame) throw new Error("Expected an SSR iframe");
    expect(h.frame()).toBe(h.serverFrame);
    expect(h.slot.dataset.state).toBe("ready");
  });

  test("SSR-open ignores a ready mark of another provider", () => {
    const h = setup(1440, true, true, (frame) => {
      frame.contentDocument!.documentElement.dataset.cloudPanelReady = "second";
    });
    expect(h.slot.dataset.state).toBe("loading");
  });

  test("double-click forgets a committed width and follows the responsive CSS default again", () => {
    const h = setup();
    h.open();
    const separator = h.slot.querySelector<HTMLElement>(".cloud-panel__resize")!;
    const key = () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", cancelable: true }));
    key();
    expect(separator.getAttribute("aria-valuenow")).toBe("25");
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("");
    expect(document.cookie).toContain("cloud_panel=1:fixture:");
    expect(separator.getAttribute("aria-valuenow")).toBe("26");
    h.resize(1194);
    expect(separator.getAttribute("aria-valuenow")).toBe("21.5");
    key();
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("22.5rem");
    separator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(h.canvas.style.getPropertyValue("--cloud-panel-width-set")).toBe("");
    expect(separator.getAttribute("aria-valuenow")).toBe("21.5");
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
  const pageContext: PanelPageContext = {
    v: 1,
    seq: 0,
    pageId: "11111111-1111-4111-8111-111111111111",
    app: "mail",
    scope: { type: "mail.mailbox", id: "Box001" },
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const setupContext = (context: PanelPageContext | null = pageContext, consent = true, answer?: boolean | null, restored = false) =>
    setup(1440, false, true, undefined, false, undefined, { context, consent, restored, ...(answer !== undefined ? { answer } : {}) });
  // A loaded provider document: its own location and the ready mark its PanelRuntime writes.
  const showDocument = (frame: HTMLIFrameElement, window: object, provider = frame.dataset.cloudPanelFrame) => {
    Object.defineProperty(frame, "contentWindow", { configurable: true, value: window });
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      value: { documentElement: { dataset: { cloudPanelReady: provider } } },
    });
  };
  const spyFrame = (h: ReturnType<typeof setup>) => {
    const post = mock((_data: unknown, _origin: string) => {});
    showDocument(h.frame(), { postMessage: post, location: new URL(h.frame().src, location.origin) });
    return post;
  };
  const ready = (h: ReturnType<typeof setup>, provider = h.slot.dataset.provider) =>
    h.message({ type: "cloud.panel.ready", v: 1, provider });
  const consent = (provider: string, allowed: boolean) =>
    window.dispatchEvent(new CustomEvent("cloud.panel.consent", { detail: { provider, allowed } }));
  const registerShortcut = (id: string, shortcut: string, extra: Partial<ContextAwareCommand> = {}) => {
    const dispose = registerContextAwareCommand({ id, title: id, description: "", shortcut, action: () => {}, ...extra });
    commandDisposers.push(dispose);
    return dispose;
  };
  const setupCore = (context: PanelPageContext | null = pageContext) =>
    setup(1440, false, true, undefined, false, undefined, { context, consent: true, providerIds: ["core", "fixture"] });
  const commandBurst = () => {
    for (let i = 0; i < 20; i++) window.dispatchEvent(new Event(COMMANDS_CHANGED));
  };

  test("a lazy installer clears the retained frame's URL context when the arriving page disables sharing", () => {
    const h = setup(
      1440,
      true,
      true,
      undefined,
      false,
      (id) => `/app/${id}/panel?${new URLSearchParams({ [PANEL_CONTEXT_PARAM]: JSON.stringify(pageContext) })}`,
      { context: null, consent: false, providerIds: ["core", "fixture"] },
    );
    const shown = new URL(h.frame().src);
    const post = mock((_data: unknown, _origin: string) => {});
    showDocument(h.frame(), {
      postMessage: post,
      location: shown,
      history: {
        state: null,
        replaceState: (_state: unknown, _unused: string, url: string) => {
          shown.href = new URL(url, shown).href;
        },
      },
    });
    ready(h);
    expect(post.mock.calls.map(([data]) => data).filter(isPanelContextMessage)).toEqual([
      { type: "cloud.panel.context", v: 1, context: null },
    ]);
    expect(shown.searchParams.has(PANEL_CONTEXT_PARAM)).toBe(false);
    if (!h.serverFrame) throw new Error("Expected an SSR iframe");
    expect(h.frame()).toBe(h.serverFrame);
  });

  test.each([
    { provider: "fixture", allowed: null, revision: 0 },
    { provider: "fixture", allowed: null, revision: 1 },
    { provider: "fixture", allowed: false, revision: 0 },
    { provider: "fixture", allowed: false, revision: 1 },
    { provider: "fixture", allowed: true, revision: 0 },
  ] satisfies PanelConsentSnapshot[])(
    "a swapped page's differing consent snapshot stops sharing until a fresh read: %j",
    async (consent) => {
      const read = Promise.withResolvers<Response>();
      const fetch = spyOn(globalThis, "fetch").mockReturnValue(read.promise);
      fetchSpy = fetch;
      const h = setupContext(pageContext, true, true);
      h.open();
      const post = spyFrame(h);
      ready(h);
      const contexts = () => post.mock.calls.map(([data]) => data).filter(isPanelContextMessage);
      expect(contexts().at(-1)?.context).toEqual(pageContext);
      const data = readShellData();
      if (!data?.panel) throw new Error("Expected panel shell data");
      const root = document.createElement("div");
      root.setAttribute("data-nav-root", "");
      const script = document.getElementById("cloud-shell-data");
      if (!script) throw new Error("Expected shell data script");
      const next = { ...pageContext, pageId: "22222222-2222-4222-8222-222222222222", help: ["next-help"] };
      const arriving = script.cloneNode();
      arriving.textContent = JSON.stringify({ ...data, panel: { ...data.panel, context: next, consent } });
      root.append(arriving);
      script.replaceWith(root);
      try {
        window.dispatchEvent(new CustomEvent("ssr:nav-swapped", { detail: { root } }));
        expect(contexts().at(-1)?.context).toBeNull();
        expect(contexts().some((message) => message.context?.help?.includes("next-help"))).toBe(false);
        expect(h.slot.dataset.contextAllowed).toBe("false");
        await tick();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0]?.[0]).toBe("/api/me/panel-consent");
        expect(contexts().at(-1)?.context).toBeNull();
        read.resolve(Response.json({ answers: { fixture: { allowed: true, revision: 2 } } }));
        await tick();
        expect(contexts().at(-1)?.context).toEqual({ ...next, pageId: pageContext.pageId, seq: 1 });
      } finally {
        read.resolve(Response.json({ answers: {} }));
        await tick();
      }
    },
  );

  const swapShellData = (panel: (current: Record<string, unknown>) => Record<string, unknown>) => {
    const data = readShellData();
    const script = document.getElementById("cloud-shell-data");
    if (!data?.panel || !script) throw new Error("Expected panel shell data");
    const root = document.createElement("div");
    root.setAttribute("data-nav-root", "");
    const arriving = script.cloneNode();
    arriving.textContent = JSON.stringify({ ...data, panel: panel(data.panel) });
    root.append(arriving);
    script.replaceWith(root);
    window.dispatchEvent(new CustomEvent("ssr:nav-swapped", { detail: { root } }));
  };
  const nextContext = { ...pageContext, pageId: "22222222-2222-4222-8222-222222222222", help: ["next-help"] };

  test("an open consent provider reads its answer again when the swapped page carries none", async () => {
    const read = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch").mockReturnValue(read.promise);
    fetchSpy = fetch;
    const h = setupContext(pageContext, true, true);
    h.open();
    const post = spyFrame(h);
    ready(h);
    // Another tab closed the panel: the shared cookie is closed, so the server sent no answer.
    swapShellData(({ consent: _consent, ...panel }) => ({ ...panel, context: nextContext }));
    const contexts = () => post.mock.calls.map(([data]) => data).filter(isPanelContextMessage);
    expect(contexts().some((message) => message.context?.help?.includes("next-help"))).toBe(false);
    await tick();
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/me/panel-consent");
    read.resolve(Response.json({ answers: { fixture: { allowed: false, revision: 2 } } }));
    await tick();
    expect(contexts().some((message) => message.context?.help?.includes("next-help"))).toBe(false);
  });

  test("a closed panel forgets cached consent after a swap without an answer and reads it on open", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ answers: { fixture: { allowed: false, revision: 2 } } }));
    fetchSpy = fetch;
    const h = setupContext(pageContext, true, true);
    h.open();
    ready(h);
    h.click("[data-cloud-panel-close]");
    expect(fetch).not.toHaveBeenCalled();
    swapShellData(({ consent: _consent, ...panel }) => ({ ...panel, context: nextContext }));
    h.open();
    await tick();
    expect(fetch.mock.calls.map(([url]) => url)).toContain("/api/me/panel-consent");
  });

  for (const request of ["GET", "PUT"] as const) {
    test(`a delayed consent ${request} cannot override a newer answer from a swapped page`, async () => {
      const response = Promise.withResolvers<Response>();
      const fetch = spyOn(globalThis, "fetch").mockReturnValue(response.promise);
      fetchSpy = fetch;
      const h = setupContext(pageContext, true, request === "GET");
      h.open();
      const { post, shown } = loadedDocument(h, h.frame().src);
      ready(h);
      if (request === "GET") restore();
      else h.click('[data-cloud-panel-consent-answer="allow"]');
      await tick();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0]?.[1]?.method ?? "GET").toBe(request);
      swapShellData((panel) => ({
        ...panel,
        context: nextContext,
        consent: { provider: "fixture", allowed: false, revision: 3 },
      }));
      const before = post.mock.calls.length;
      response.resolve(
        Response.json(
          request === "GET"
            ? { answers: { fixture: { allowed: true, revision: 2 } } }
            : { provider: "fixture", allowed: true, revision: 2 },
        ),
      );
      await tick();
      await tick();
      ready(h);
      expect(h.slot.dataset.contextAllowed).toBe("false");
      expect(shown.searchParams.has(PANEL_CONTEXT_PARAM)).toBe(false);
      expect(
        post.mock.calls
          .slice(before)
          .map(([data]) => data)
          .filter(isPanelContextMessage)
          .every((message) => message.context === null),
      ).toBe(true);
    });
  }

  for (const state of ["queued", "conflict"] as const) {
    test(`a ${state} Allow operation cannot overwrite a newer swapped-page withdrawal`, async () => {
      const pending = Promise.withResolvers<Response>();
      const fetch = spyOn(globalThis, "fetch")
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(Response.json({ answers: { fixture: { allowed: false, revision: 3 } } }))
        .mockResolvedValueOnce(Response.json({ provider: "fixture", allowed: true, revision: 4 }));
      fetchSpy = fetch;
      const h = setupContext(pageContext, true, false);
      h.open();
      const { post, shown } = loadedDocument(h, h.frame().src);
      ready(h);
      if (state === "queued") restore();
      h.click('[data-cloud-panel-consent-answer="allow"]');
      await tick();
      expect(fetch).toHaveBeenCalledTimes(1);
      swapShellData((panel) => ({
        ...panel,
        context: nextContext,
        consent: { provider: "fixture", allowed: false, revision: 3 },
      }));
      pending.resolve(
        state === "conflict"
          ? new Response(null, { status: 409 })
          : Response.json({ answers: { fixture: { allowed: false, revision: 1 } } }),
      );
      await tick();
      await tick();
      const writes = fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
      expect(writes).toHaveLength(state === "queued" ? 0 : 1);
      expect(h.slot.dataset.contextAllowed).toBe("false");
      expect(shown.searchParams.has(PANEL_CONTEXT_PARAM)).toBe(false);
      expect(
        post.mock.calls
          .map(([data]) => data)
          .filter(isPanelContextMessage)
          .every((message) => message.context === null),
      ).toBe(true);
    });
  }

  test("a swapped withdrawal fences an Allow retry even when its revision was already read", async () => {
    const retry = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ answers: { fixture: { allowed: false, revision: 3 } } }))
      .mockReturnValueOnce(retry.promise);
    fetchSpy = fetch;
    const h = setupContext(pageContext, true, false);
    h.open();
    ready(h);
    h.click('[data-cloud-panel-consent-answer="allow"]');
    await tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    swapShellData((panel) => ({
      ...panel,
      context: nextContext,
      consent: { provider: "fixture", allowed: false, revision: 3 },
    }));
    retry.resolve(Response.json({ provider: "fixture", allowed: true, revision: 4 }));
    await tick();
    expect(h.slot.dataset.contextAllowed).toBe("false");
  });

  test("a swapped withdrawal fences pending Allow for an inactive provider", async () => {
    const pending = Promise.withResolvers<Response>();
    const fetch = spyOn(globalThis, "fetch")
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(Response.json({ answers: { fixture: { allowed: false, revision: 3 } } }))
      .mockResolvedValueOnce(Response.json({ provider: "fixture", allowed: true, revision: 4 }));
    fetchSpy = fetch;
    const h = setup(1440, false, true, undefined, false, undefined, {
      context: pageContext,
      consent: true,
      answer: false,
      providerIds: ["fixture", "core"],
    });
    h.open();
    ready(h);
    h.click('[data-cloud-panel-consent-answer="allow"]');
    await tick();
    h.open("core");
    swapShellData((panel) => ({
      ...panel,
      context: nextContext,
      consent: { provider: "fixture", allowed: false, revision: 3 },
    }));
    pending.resolve(new Response(null, { status: 409 }));
    await tick();
    await tick();
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
    h.open("fixture");
    await tick();
    expect(h.slot.dataset.contextAllowed).toBe("false");
  });

  test("a swapped page with the same consent answer shares at once and reads nothing", () => {
    const fetch = spyOn(globalThis, "fetch");
    fetchSpy = fetch;
    const h = setupContext(pageContext, true, true);
    h.open();
    const post = spyFrame(h);
    ready(h);
    const data = readShellData();
    const script = document.getElementById("cloud-shell-data");
    if (!data?.panel || !script) throw new Error("Expected panel shell data");
    const root = document.createElement("div");
    root.setAttribute("data-nav-root", "");
    const arriving = script.cloneNode();
    const next = { ...pageContext, pageId: "22222222-2222-4222-8222-222222222222", help: ["next-help"] };
    arriving.textContent = JSON.stringify({ ...data, panel: { ...data.panel, context: next } });
    root.append(arriving);
    script.replaceWith(root);
    window.dispatchEvent(new CustomEvent("ssr:nav-swapped", { detail: { root } }));
    const contexts = post.mock.calls.map(([message]) => message).filter(isPanelContextMessage);
    expect(contexts.at(-1)?.context).toEqual({ ...next, pageId: pageContext.pageId, seq: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("a lazy installer keeps the SSR frame's document identity after a page swap", () => {
    const initial = { ...pageContext, seq: 7, help: ["mail-help"] };
    const next: PanelPageContext = {
      ...pageContext,
      seq: 20,
      pageId: "22222222-2222-4222-8222-222222222222",
      app: "files",
      scope: { type: "files.folder", id: "folder2" },
      help: ["files-help"],
    };
    const h = setup(
      1440,
      true,
      true,
      undefined,
      false,
      (id) => `/app/${id}/panel?${new URLSearchParams({ [PANEL_CONTEXT_PARAM]: JSON.stringify(initial) })}`,
      { context: next, consent: false, providerIds: ["core", "fixture"] },
    );
    const post = spyFrame(h);
    ready(h);
    const first = post.mock.calls.map(([data]) => data).find(isPanelContextMessage)?.context;
    expect(first).toEqual({ ...next, pageId: initial.pageId, seq: initial.seq + 1 });
    if (!h.serverFrame) throw new Error("Expected an SSR iframe");
    expect(h.frame()).toBe(h.serverFrame);
  });

  test.each(["{", '{"pageId":"invalid","seq":7}'])("a malformed SSR frame context is ignored: %s", (raw) => {
    const h = setup(1440, true, true, undefined, false, (id) => `/app/${id}/panel?${new URLSearchParams({ [PANEL_CONTEXT_PARAM]: raw })}`, {
      context: pageContext,
      consent: false,
      providerIds: ["core", "fixture"],
    });
    const post = spyFrame(h);
    ready(h);
    expect(post.mock.calls.map(([data]) => data).find(isPanelContextMessage)?.context).toEqual(pageContext);
  });

  test("a swapped column follows server context with the document pageId and increasing seq", () => {
    const h = setupCore();
    h.open();
    const frame = h.frame();
    const post = spyFrame(h);
    ready(h);
    const swap = (context: PanelPageContext | null) => {
      const oldScript = document.getElementById("cloud-shell-data")!;
      const data = JSON.parse(oldScript.textContent ?? "{}");
      oldScript.remove();
      const root = document.createElement("div");
      root.setAttribute("data-nav-root", "");
      const arriving = document.createElement("script");
      arriving.id = "cloud-shell-data";
      arriving.type = "application/json";
      arriving.textContent = JSON.stringify({ ...data, panel: { ...data.panel, context } });
      const toggle = document.createElement("button");
      toggle.setAttribute("data-cloud-panel-toggle", "");
      toggle.textContent = "Panel";
      root.append(arriving, toggle);
      const old = document.querySelector("[data-nav-root]");
      if (old) old.replaceWith(root);
      else h.canvas.prepend(root);
      window.dispatchEvent(new CustomEvent("ssr:nav-swapped", { detail: { root } }));
      expect(root.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
      expect(h.frame()).toBe(frame);
    };
    const next: PanelPageContext = {
      ...pageContext,
      pageId: "22222222-2222-4222-8222-222222222222",
      app: "files",
      scope: { type: "files.folder", id: "folder2" },
      help: ["files-help"],
    };
    swap(next);
    const messages = () => post.mock.calls.map(([data]) => data).filter(isPanelContextMessage);
    const first = messages().at(-1)?.context;
    expect(first).toEqual({ ...next, pageId: pageContext.pageId, seq: 1 });
    swap(null);
    expect(messages().at(-1)?.context).toBeNull();
    swap({ ...next, app: "mail", help: ["mail-help"] });
    expect(messages().at(-1)?.context).toEqual({ ...next, app: "mail", help: ["mail-help"], pageId: pageContext.pageId, seq: 2 });
  });

  test("a swapped page's newer consent answer applies before its context is shared", () => {
    const h = setupContext(pageContext, true, true);
    h.open();
    const post = spyFrame(h);
    ready(h);
    expect(
      post.mock.calls
        .map(([data]) => data)
        .filter(isPanelContextMessage)
        .at(-1)?.context,
    ).toEqual(pageContext);
    // Another tab withdrew sharing; the next server page carries that answer, as a reload would.
    const data = JSON.parse(document.getElementById("cloud-shell-data")?.textContent ?? "{}");
    document.getElementById("cloud-shell-data")?.remove();
    const root = document.createElement("div");
    root.setAttribute("data-nav-root", "");
    const arriving = document.createElement("script");
    arriving.id = "cloud-shell-data";
    arriving.type = "application/json";
    arriving.textContent = JSON.stringify({
      ...data,
      panel: {
        ...data.panel,
        context: { ...pageContext, pageId: "22222222-2222-4222-8222-222222222222", help: ["next-help"] },
        consent: { provider: "fixture", allowed: false, revision: 2 },
      },
    });
    root.append(arriving);
    h.canvas.prepend(root);
    window.dispatchEvent(new CustomEvent("ssr:nav-swapped", { detail: { root } }));
    const contexts = post.mock.calls.map(([data]) => data).filter(isPanelContextMessage);
    expect(contexts.at(-1)?.context).toBeNull();
    expect(contexts.some((message) => message.context?.help?.includes("next-help"))).toBe(false);
    expect(h.slot.dataset.contextAllowed).toBe("false");
  });

  test("cross-page nav popstate closes the phone panel sheet", () => {
    const h = setup(390);
    h.open();
    expect(h.canvas.dataset.panelSheet).toBe("open");
    window.dispatchEvent(new CustomEvent("ssr:nav-popstate"));
    expect(h.canvas.dataset.panelSheet).toBeUndefined();
  });

  test("foreign providers receive no URL or live context until consent; allow delivers live without reloading", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: {} })))
      .mockResolvedValue(new Response(JSON.stringify({ provider: "fixture", allowed: true, revision: 1 })));
    fetchSpy = fetch;
    const h = setupContext();
    h.open();
    expect(h.slot.dataset.state).toBe("loading");
    expect(h.slot.querySelector("iframe")).toBeNull();
    await tick();
    expect(h.frame().src).not.toContain("cloud_panel_context");
    expect(h.slot.dataset.consent).toBe("ask");
    const frame = h.frame();
    const post = spyFrame(h);
    ready(h);
    expect(post).not.toHaveBeenCalled();
    h.click('[data-cloud-panel-consent-answer="allow"]');
    expect(h.slot.querySelector<HTMLButtonElement>('[data-cloud-panel-consent-answer="deny"]')!.disabled).toBe(true);
    await tick();
    expect(h.frame()).toBe(frame);
    expect(post.mock.calls).toEqual([[{ type: "cloud.panel.context", v: 1, context: pageContext }, location.origin]]);
    expect(h.slot.dataset.consent).toBeUndefined();
    h.click("[data-cloud-panel-retry]");
    expect(new URL(h.frame().src).searchParams.get("cloud_panel_context")).toBe(JSON.stringify(pageContext));
    expect(fetch.mock.calls.filter(([, init]) => !init?.method)).toHaveLength(1);
  });

  test("stored approval is read before the first provider load; a failed read asks and never leaks", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 1 } } })),
    );
    const h = setupContext();
    h.open();
    await tick();
    expect(new URL(h.frame().src).searchParams.get("cloud_panel_context")).toBe(JSON.stringify(pageContext));
    h.dispose();
    h.dom.cleanup();
    fetchSpy.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
    const failed = setupContext();
    failed.open();
    await tick();
    expect(failed.frame().src).not.toContain("cloud_panel_context");
    expect(failed.slot.dataset.consent).toBe("ask");
  });

  test("platform providers get scope without a consent read, and false context sends nothing", () => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected consent read"));
    const h = setupContext(pageContext, false);
    h.open();
    expect(h.frame().src).toContain("cloud_panel_context");
    const post = spyFrame(h);
    ready(h);
    expect(post.mock.calls[0]).toEqual([{ type: "cloud.panel.context", v: 1, context: pageContext }, location.origin]);
    expect(fetchSpy).not.toHaveBeenCalled();
    h.dispose();
    h.dom.cleanup();
    const disabled = setupContext(null, false);
    disabled.open();
    const disabledPost = spyFrame(disabled);
    ready(disabled);
    expect(disabled.frame().src).not.toContain("cloud_panel_context");
    expect(disabledPost).not.toHaveBeenCalled();
  });

  test("switch, close and consent withdrawal clear the old context, and withdrawal stops later updates", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 1 }, second: { allowed: true, revision: 1 } } })),
      )
      .mockResolvedValue(new Response(JSON.stringify({ provider: "fixture", allowed: false, revision: 2 })));
    const { publishPageContext } = await import("./panel");
    const h = setupContext(pageContext, true, true);
    h.open();
    const old = spyFrame(h);
    ready(h);
    h.open("second");
    expect(old.mock.calls.at(-1)).toEqual([{ type: "cloud.panel.context", v: 1, context: null }, location.origin]);
    await tick();
    const second = spyFrame(h);
    ready(h, "second");
    handlePanelRequest({ action: "close" });
    expect(second.mock.calls.at(-1)?.[0]).toEqual({ type: "cloud.panel.context", v: 1, context: null });
    h.open();
    const active = spyFrame(h);
    ready(h);
    consent("fixture", false);
    expect(active.mock.calls.at(-1)?.[0]).toEqual({ type: "cloud.panel.context", v: 1, context: null });
    await tick();
    const count = active.mock.calls.length;
    const dispose = publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
    expect(active).toHaveBeenCalledTimes(count);
    h.click("[data-cloud-panel-retry]");
    expect(h.frame().src).not.toContain("cloud_panel_context");
    dispose();
  });

  test("withdrawal also drops the URL snapshot, so a provider reload stays without context", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ provider: "fixture", allowed: false, revision: 2 })),
    );
    const h = setupContext(pageContext, true, true);
    h.open();
    const shown = new URL(h.frame().src);
    const post = mock((_data: unknown, _origin: string) => {});
    const replaceState = mock((_state: unknown, _title: string, path: string) => {
      const next = new URL(path, location.origin);
      shown.search = next.search;
    });
    showDocument(h.frame(), { postMessage: post, location: shown, history: { state: null, replaceState } });
    ready(h);
    consent("fixture", false);
    await tick();
    expect(shown.searchParams.has("cloud_panel_context")).toBe(false);
    expect(shown.searchParams.get("base")).toBe("1");
    // The provider reloads its own, now clean address and reports ready again: nothing is sent to it.
    post.mockClear();
    ready(h);
    expect(post).not.toHaveBeenCalled();
  });

  test("withdrawal cleans a provider address that holds a raw backslash in its query", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ provider: "fixture", allowed: false, revision: 2 })),
    );
    const h = setupContext(pageContext, true, true);
    h.open();
    const shown = new URL(h.frame().src);
    // Browsers keep a raw backslash in the query, for example a search for C:\\Users built by hand.
    shown.search = `${shown.search}&q=C:\\Users`;
    expect(shown.search).toContain("\\");
    const replaceState = mock((_state: unknown, _title: string, path: string) => {
      shown.search = new URL(path, location.origin).search;
    });
    showDocument(h.frame(), { postMessage: mock(() => {}), location: shown, history: { state: null, replaceState } });
    ready(h);
    consent("fixture", false);
    await tick();
    expect(shown.searchParams.has("cloud_panel_context")).toBe(false);
    expect(shown.searchParams.get("q")).toBe("C:\\Users");
  });

  test("a frame that navigated to another provider's page gets no context", async () => {
    const { publishPageContext } = await import("./panel");
    const h = setupContext(pageContext, false);
    h.open();
    const post = spyFrame(h);
    ready(h);
    post.mockClear();
    showDocument(h.frame(), { postMessage: post, location: new URL("/app/second/panel", location.origin) }, "second");
    const dispose = publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
    expect(post).not.toHaveBeenCalled();
    dispose();
  });

  test("a page restored from the back/forward cache stops sharing until it has read the answers again", async () => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answers: { fixture: { allowed: false, revision: 2 } } })),
    );
    fetchSpy = fetch;
    const { publishPageContext } = await import("./panel");
    const h = setupContext(pageContext, true, true);
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    post.mockClear();
    restore();
    expect(post.mock.calls).toEqual([[{ type: "cloud.panel.context", v: 1, context: null }, location.origin]]);
    const dispose = publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
    dispose();
  });

  test("the controller mounts the panel menu over the server placeholder, hidden for providers without consent", () => {
    const h = setupContext(pageContext, true, true);
    const host = h.slot.querySelector<HTMLElement>("[data-cloud-panel-menu]")!;
    expect(host.textContent).not.toContain("Placeholder");
    expect(host.querySelector('[aria-label="Panel menu"]')).not.toBeNull();
    expect(host.style.visibility).toBe("visible");
    h.dispose();
    h.dom.cleanup();
    const core = setupContext(pageContext, false);
    const coreHost = core.slot.querySelector<HTMLElement>("[data-cloud-panel-menu]")!;
    expect(coreHost.style.visibility).toBe("hidden");
    expect(coreHost.inert).toBe(true);
  });

  const restore = () => {
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
  };
  // A provider document whose address and history the controller may rewrite.
  const loadedDocument = (h: ReturnType<typeof setup>, address: string) => {
    const shown = new URL(address, location.origin);
    const post = mock((_data: unknown, _origin: string) => {});
    const history = {
      state: null,
      replaceState: mock((_state: unknown, _title: string, path: string) => {
        shown.search = new URL(path, location.origin).search;
      }),
    };
    showDocument(h.frame(), { postMessage: post, location: shown, history });
    return { shown, post, history };
  };

  test("Core receives only conflict-free shortcut fields, with cloud rows first, and keeps them out of every URL", async () => {
    const { publishPageContext } = await import("./panel");
    const h = setupCore();
    registerShortcut("mail.edit", "e", { title: "Edit Ada", description: "Selected contact", scope: "selection", icon: "ti ti-edit" });
    registerShortcut("mail.open", "o", { scope: "page" });
    registerShortcut("cloud.help", "shift+/");
    registerShortcut("cloud.search", "mod+k");
    registerShortcut("mail.conflict", "mod+k");
    h.open();
    const src = h.frame().src;
    const { post, history } = loadedDocument(h, src);
    ready(h);
    await Promise.resolve();
    const shortcuts = [
      { id: "cloud.help", title: "cloud.help", shortcut: "shift+/" },
      { id: "mail.open", title: "mail.open", shortcut: "o", scope: "page" },
      { id: "mail.edit", title: "Edit Ada", description: "Selected contact", shortcut: "e", scope: "selection" },
    ];
    expect(post.mock.calls).toEqual([[{ type: "cloud.panel.context", v: 1, context: pageContext, shortcuts }, location.origin]]);
    const stop = publishPageContext({ scope: { type: "contacts.contact", id: "Ada" } });
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ context: { seq: 1 }, shortcuts });
    stop();
    expect(history.replaceState).toHaveBeenCalledTimes(2);
    handlePanelRequest({ action: "close" });
    expect(post.mock.calls.at(-1)?.[0]).toEqual({ type: "cloud.panel.context", v: 1, context: null });
    for (const url of [src, ...history.replaceState.mock.calls.map(([, , path]) => path)]) {
      const decoded = decodeURIComponent(url);
      expect(decoded).not.toContain("shortcuts");
      expect(decoded).not.toContain("Edit Ada");
    }
  });

  test("Core shortcut lists omit invalid scopes and drop only malformed commands", async () => {
    const h = setupCore();
    const invalidScope: unknown = "global";
    const invalidTitle: unknown = 42;
    registerShortcut("mail.edit", "e", { scope: "selection" });
    registerShortcut("mail.open", "o", { scope: invalidScope as ContextAwareCommand["scope"] });
    registerShortcut("mail.invalid", "i", { title: invalidTitle as string });
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
    const message = post.mock.calls[0]?.[0];
    expect(isPanelContextMessage(message)).toBe(true);
    expect(message).toEqual({
      type: "cloud.panel.context",
      v: 1,
      context: pageContext,
      shortcuts: [
        { id: "mail.open", title: "mail.open", shortcut: "o" },
        { id: "mail.edit", title: "mail.edit", shortcut: "e", scope: "selection" },
      ],
    });
  });

  test("Core collects no shortcuts and posts nothing on command bursts while not ready or closed", async () => {
    const h = setupCore();
    registerShortcut("mail.edit", "e");
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    const collect = mock(() => {});
    window.addEventListener("cloud.command.collect", collect);
    try {
      commandBurst();
      await Promise.resolve();
      expect(collect).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      ready(h);
      handlePanelRequest({ action: "close" });
      collect.mockClear();
      post.mockClear();
      commandBurst();
      await Promise.resolve();
      expect(collect).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("cloud.command.collect", collect);
    }
  });

  test("shortcut registrations and removals send one coalesced update with unchanged seq; unchanged bursts send nothing", async () => {
    const { publishPageContext } = await import("./panel");
    const h = setupCore();
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    expect(post.mock.calls.at(-1)?.[0]).toEqual({ type: "cloud.panel.context", v: 1, context: pageContext, shortcuts: [] });
    post.mockClear();
    const remove = registerShortcut("mail.edit", "e");
    commandBurst();
    expect(post).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ context: { seq: 0 }, shortcuts: [{ id: "mail.edit" }] });
    commandBurst();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
    remove();
    commandBurst();
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ context: { seq: 0 }, shortcuts: [] });
    const stop = publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
    registerShortcut("mail.new", "n");
    await Promise.resolve();
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ context: { seq: 1 } });
    expect(post.mock.calls.map(([data]) => (data as { context: PanelPageContext }).context.seq)).toEqual([0, 0, 1, 1]);
    stop();
    post.mockClear();
    commandBurst();
    h.dispose();
    expect(post.mock.calls).toEqual([[{ type: "cloud.panel.context", v: 1, context: null }, location.origin]]);
    post.mockClear();
    await Promise.resolve();
    commandBurst();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
  });

  test("an allowed consent provider never receives or collects shortcuts, including after command, scope and bfcache changes", async () => {
    const { publishPageContext } = await import("./panel");
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 1 } } })),
    );
    const h = setupContext(pageContext, true, true);
    h.open();
    registerShortcut("mail.edit", "e", { title: "Edit Ada" });
    const { post } = loadedDocument(h, h.frame().src);
    const collect = mock(() => {});
    window.addEventListener("cloud.command.collect", collect);
    try {
      ready(h);
      expect(post.mock.calls).toEqual([[{ type: "cloud.panel.context", v: 1, context: pageContext }, location.origin]]);
      commandBurst();
      await Promise.resolve();
      expect(post).toHaveBeenCalledTimes(1);
      const remove = registerShortcut("mail.new", "n");
      await Promise.resolve();
      remove();
      await Promise.resolve();
      expect(post).toHaveBeenCalledTimes(1);
      const stop = publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
      stop();
      restore();
      commandBurst();
      await tick();
      expect(collect).not.toHaveBeenCalled();
      expect(post.mock.calls.length).toBeGreaterThan(3);
      for (const [data] of post.mock.calls) expect(data).not.toHaveProperty("shortcuts");
    } finally {
      window.removeEventListener("cloud.command.collect", collect);
    }
  });

  for (const answer of [false, null])
    test(`a consent provider with answer ${answer} receives no command-change messages`, async () => {
      const h = setupContext(pageContext, true, answer);
      h.open();
      const { post } = loadedDocument(h, h.frame().src);
      ready(h);
      const remove = registerShortcut("mail.edit", "e");
      commandBurst();
      await Promise.resolve();
      remove();
      await Promise.resolve();
      expect(post).not.toHaveBeenCalled();
    });

  test("Core with Layout context false receives nothing on ready or command changes", async () => {
    const h = setupCore(null);
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    registerShortcut("mail.edit", "e");
    commandBurst();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    expect(h.frame().src).not.toContain("cloud_panel_context");
  });

  test("switching from Core clears it without shortcuts, never discloses to the next provider, and sends a fresh list on return and retry", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 1 } } })),
    );
    const h = setupCore();
    registerShortcut("mail.edit", "e");
    h.open();
    const old = loadedDocument(h, h.frame().src);
    ready(h);
    expect(old.post.mock.calls.at(-1)?.[0]).toHaveProperty("shortcuts");
    // The queued flush runs after switching, so it must check the provider at flush time.
    commandBurst();
    h.open("fixture");
    expect(old.post.mock.calls.at(-1)?.[0]).toEqual({ type: "cloud.panel.context", v: 1, context: null });
    await tick();
    const foreign = loadedDocument(h, h.frame().src);
    ready(h);
    const count = foreign.post.mock.calls.length;
    registerShortcut("mail.new", "n");
    commandBurst();
    await Promise.resolve();
    expect(foreign.post).toHaveBeenCalledTimes(count);
    for (const [data] of foreign.post.mock.calls) expect(data).not.toHaveProperty("shortcuts");
    h.open("core");
    const current = loadedDocument(h, h.frame().src);
    ready(h);
    const expected = [
      { id: "mail.edit", title: "mail.edit", shortcut: "e" },
      { id: "mail.new", title: "mail.new", shortcut: "n" },
    ];
    expect(current.post.mock.calls.at(-1)?.[0]).toMatchObject({ shortcuts: expected });
    h.click("[data-cloud-panel-retry]");
    expect(current.post.mock.calls.at(-1)?.[0]).toEqual({ type: "cloud.panel.context", v: 1, context: null });
    const retried = loadedDocument(h, h.frame().src);
    commandBurst();
    await Promise.resolve();
    expect(retried.post).not.toHaveBeenCalled();
    ready(h);
    expect(retried.post.mock.calls.at(-1)?.[0]).toMatchObject({ shortcuts: expected });
    handlePanelRequest({ action: "close" });
    expect(retried.post.mock.calls.at(-1)?.[0]).toEqual({ type: "cloud.panel.context", v: 1, context: null });
  });

  test("a Core frame that navigated away receives no shortcut updates", async () => {
    const h = setupCore();
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    post.mockClear();
    showDocument(h.frame(), { postMessage: post, location: new URL("/app/fixture/panel", location.origin) }, "fixture");
    registerShortcut("mail.edit", "e", { title: "Edit Ada" });
    commandBurst();
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
  });

  test("withdrawn while the provider was still loading, its address loses the snapshot once it is ready", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ provider: "fixture", allowed: false, revision: 2 })),
    );
    const h = setupContext(pageContext, true, true);
    h.open();
    const src = h.frame().src;
    expect(src).toContain("cloud_panel_context");
    loadedDocument(h, "about:blank");
    consent("fixture", false);
    await tick();
    const { shown, post } = loadedDocument(h, src);
    ready(h);
    expect(shown.searchParams.has("cloud_panel_context")).toBe(false);
    expect(post.mock.calls).toEqual([[{ type: "cloud.panel.context", v: 1, context: null }, location.origin]]);
  });

  test("a restore that reads a withdrawn answer also removes the snapshot from the provider's address", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ answers: { fixture: { allowed: false, revision: 2 } } })),
    );
    const h = setupContext(pageContext, true, true);
    h.open();
    const { shown } = loadedDocument(h, h.frame().src);
    ready(h);
    restore();
    await tick();
    expect(shown.searchParams.has("cloud_panel_context")).toBe(false);
  });

  test("a consent read from before a restore cannot fill in the answer afterwards", async () => {
    let answerOld: (response: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => (answerOld = resolve));
    const fetch = spyOn(globalThis, "fetch")
      .mockReturnValueOnce(pending)
      .mockResolvedValue(new Response(JSON.stringify({ answers: { fixture: { allowed: false, revision: 2 } } })));
    fetchSpy = fetch;
    const h = setupContext();
    h.open();
    restore();
    answerOld(new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 1 } } })));
    await tick();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.slot.dataset.contextAllowed).toBe("false");
    expect(h.frame().src).not.toContain("cloud_panel_context");
  });

  const deferred = () => {
    let resolve: (response: Response) => void = () => {};
    const promise = new Promise<Response>((done) => (resolve = done));
    return { promise, resolve };
  };
  const contexts = (post: ReturnType<typeof mock>) =>
    post.mock.calls.map(([data]) => (data as { context: PanelPageContext | null }).context);

  test("live context also moves into the provider's address, so a reload renders the same place", async () => {
    const { publishPageContext } = await import("./panel");
    const h = setupContext(pageContext, false);
    h.open();
    const { shown } = loadedDocument(h, h.frame().src);
    ready(h);
    const dispose = publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
    expect(JSON.parse(shown.searchParams.get("cloud_panel_context")!).scope).toEqual({ type: "spaces.space", id: "Space1" });
    dispose();
  });

  test("a restore while a withdrawal is saving reads the answers only after the save, and never shares meanwhile", async () => {
    const put = deferred();
    const fetch = spyOn(globalThis, "fetch")
      .mockReturnValueOnce(put.promise)
      .mockResolvedValue(new Response(JSON.stringify({ answers: { fixture: { allowed: false, revision: 2 } } })));
    fetchSpy = fetch;
    const { publishPageContext } = await import("./panel");
    const h = setupContext(pageContext, true, true);
    h.open();
    const { shown, post } = loadedDocument(h, h.frame().src);
    ready(h);
    consent("fixture", false);
    expect(contexts(post).at(-1)).toBeNull();
    expect(shown.searchParams.has("cloud_panel_context")).toBe(false);
    restore();
    const dispose = publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
    await tick();
    // Reads and writes run in order: the restore's read waits for the pending save.
    expect(fetch).toHaveBeenCalledTimes(1);
    put.resolve(new Response(JSON.stringify({ provider: "fixture", allowed: false, revision: 2 })));
    await tick();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      contexts(post)
        .slice(1)
        .every((context) => context === null),
    ).toBe(true);
    expect(h.slot.dataset.contextAllowed).toBe("false");
    dispose();
  });

  test("a document that arrives after the withdrawal with the old address is cleaned when it reports ready", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ provider: "fixture", allowed: false, revision: 2 })),
    );
    const h = setupContext(pageContext, true, true);
    h.open();
    const src = h.frame().src;
    loadedDocument(h, src);
    ready(h);
    // The outgoing document is cleaned at once; the navigation already under way still uses the old address.
    consent("fixture", false);
    await tick();
    const arriving = loadedDocument(h, src);
    ready(h);
    expect(arriving.shown.searchParams.has("cloud_panel_context")).toBe(false);
    expect(contexts(arriving.post)).toEqual([null]);
  });

  test("a restore before the lazy controller arrived rechecks the answers before anything is shared", async () => {
    const read = deferred();
    const fetch = spyOn(globalThis, "fetch").mockReturnValue(read.promise);
    fetchSpy = fetch;
    {
      const h = setupContext(pageContext, true, true, true);
      h.open();
      const { post } = loadedDocument(h, h.frame().src);
      ready(h);
      await tick();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(contexts(post).every((context) => context === null)).toBe(true);
      read.resolve(new Response(JSON.stringify({ answers: { fixture: { allowed: false, revision: 2 } } })));
      await tick();
      await tick();
      expect(h.slot.dataset.contextAllowed).toBe("false");
      expect(contexts(post).every((context) => context === null)).toBe(true);
    }
  });

  test("after a save with an unknown outcome nothing is shared until the person answers again", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
      .mockResolvedValue(new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 1 } } })));
    const h = setupContext(pageContext, true, true);
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    consent("fixture", false);
    await tick();
    expect(h.slot.dataset.consent).toBe("ask");
    restore();
    await tick();
    await tick();
    expect(h.slot.dataset.contextAllowed).toBe("false");
    expect(
      contexts(post)
        .slice(1)
        .every((context) => context === null),
    ).toBe(true);
  });

  const bodies = (fetch: { mock: { calls: unknown[][] } }) =>
    fetch.mock.calls.flatMap(([, init]) => {
      const body = (init as RequestInit | undefined)?.body;
      return typeof body === "string" ? [JSON.parse(body)] : [];
    });

  test("a conflict reads the current revision and saves the person's choice once more", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "CONFLICT" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 7 } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ provider: "fixture", allowed: false, revision: 8 })));
    fetchSpy = fetch;
    const h = setupContext(pageContext, true, true);
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    post.mockClear();
    consent("fixture", false);
    await tick();
    await tick();
    expect(bodies(fetch).at(-1)).toEqual({ allowed: false, revision: 7 });
    expect(h.slot.dataset.contextAllowed).toBe("false");
    expect(h.slot.dataset.consent).toBeUndefined();
    expect(contexts(post).every((context) => context === null)).toBe(true);
  });

  test("a second conflict shows the question again and shares nothing", async () => {
    fetchSpy = spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 7 } } })))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValue(new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 9 } } })));
    const h = setupContext(pageContext, true, true);
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    post.mockClear();
    consent("fixture", false);
    await tick();
    await tick();
    await tick();
    expect(h.slot.dataset.contextAllowed).toBe("false");
    expect(h.slot.dataset.consent).toBe("ask");
    expect(h.slot.querySelector("[data-cloud-panel-consent-error]")!.textContent).toContain("Not saved");
    expect(contexts(post).every((context) => context === null)).toBe(true);
  });

  test("a save that failed reads the current revision and keeps sharing off until the person answers again", async () => {
    const fetch = spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new DOMException("The operation timed out.", "TimeoutError"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ answers: { fixture: { allowed: true, revision: 2 } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ provider: "fixture", allowed: true, revision: 3 })));
    fetchSpy = fetch;
    const h = setupContext(pageContext, true, true);
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    post.mockClear();
    consent("fixture", false);
    await tick();
    await tick();
    expect(h.slot.dataset.contextAllowed).toBe("false");
    expect(h.slot.dataset.consent).toBe("ask");
    expect(contexts(post).every((context) => context === null)).toBe(true);
    h.click('[data-cloud-panel-consent-answer="allow"]');
    await tick();
    await tick();
    expect(bodies(fetch).at(-1)).toEqual({ allowed: true, revision: 2 });
    expect(h.slot.dataset.contextAllowed).toBe("true");
  });

  test("a slow save does not pull focus back into the panel after the reader moved on", async () => {
    const put = deferred();
    fetchSpy = spyOn(globalThis, "fetch").mockReturnValueOnce(put.promise);
    const h = setupContext(pageContext, true, null);
    h.open();
    loadedDocument(h, h.frame().src);
    ready(h);
    const allow = h.slot.querySelector<HTMLButtonElement>('[data-cloud-panel-consent-answer="allow"]')!;
    allow.focus();
    allow.click();
    h.opener.focus();
    put.resolve(new Response(JSON.stringify({ provider: "fixture", allowed: true, revision: 1 })));
    await tick();
    await tick();
    expect(h.slot.dataset.contextAllowed).toBe("true");
    expect(document.activeElement).toBe(h.opener);
  });

  test("an Allow response that arrives after a restore is checked against the server again", async () => {
    const put = deferred();
    const fetch = spyOn(globalThis, "fetch")
      .mockReturnValueOnce(put.promise)
      .mockResolvedValue(new Response(JSON.stringify({ answers: { fixture: { allowed: false, revision: 2 } } })));
    fetchSpy = fetch;
    const h = setupContext(pageContext, true, null);
    h.open();
    const { post } = loadedDocument(h, h.frame().src);
    ready(h);
    h.click('[data-cloud-panel-consent-answer="allow"]');
    restore();
    await tick();
    put.resolve(new Response(JSON.stringify({ provider: "fixture", allowed: true, revision: 1 })));
    await tick();
    await tick();
    // The restore's read runs after the save and has the final word.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(contexts(post).every((context) => context === null)).toBe(true);
    expect(h.slot.dataset.contextAllowed).toBe("false");
  });

  test("context that arrived live does not make the same provider reload on the next open", async () => {
    const { publishPageContext } = await import("./panel");
    const h = setupContext(pageContext, false);
    h.open();
    const frame = h.frame();
    spyFrame(h);
    ready(h);
    const dispose = publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
    h.open();
    expect(h.frame()).toBe(frame);
    dispose();
  });

  test("the first client-side open of a foreign provider moves focus once its answer is known", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ answers: {} })));
    const h = setupContext();
    h.open();
    expect(document.activeElement).toBe(h.opener);
    await tick();
    expect(h.slot.dataset.consent).toBe("ask");
    expect(document.activeElement).toBe(h.slot.querySelector("[data-cloud-panel-consent]"));
  });

  test("publisher collection works before lazy loading; last source wins, effective changes advance seq and disposal restores only its part", async () => {
    const dom = createDomTestHarness();
    const { publishPageContext } = await import("./panel");
    const a = publishPageContext({ scope: { type: "mail.mailbox", id: "Box002" } });
    // setup installs a fresh document: use its beforeInstall callback to publish before the controller.
    a();
    dom.cleanup();
    let disposeEarly = () => {};
    const h = setup(
      1440,
      true,
      true,
      () => {
        disposeEarly = publishPageContext({ scope: { type: "mail.mailbox", id: "Box002" } });
      },
      false,
      undefined,
      { context: pageContext, consent: false },
    );
    const post = spyFrame(h);
    ready(h);
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ context: { seq: 1, scope: { id: "Box002" } } });
    const b = publishPageContext({ scope: { type: "spaces.space", id: "Space1" } });
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({
      context: { seq: 2, scope: { type: "spaces.space", id: "Space1" }, pageId: pageContext.pageId },
    });
    disposeEarly(); // A hidden older source does not change the effective place.
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ context: { seq: 2 } });
    b();
    expect(post.mock.calls.at(-1)?.[0]).toMatchObject({ context: { seq: 3, scope: pageContext.scope } });
  });

  test("save failures keep the question and error visible and re-enable the answers", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
    const h = setupContext(pageContext, true, null);
    h.open();
    ready(h);
    h.click('[data-cloud-panel-consent-answer="allow"]');
    await tick();
    expect(h.slot.dataset.consent).toBe("ask");
    expect(h.slot.querySelector("[data-cloud-panel-consent-error]")!.textContent).toContain("Not saved");
    expect(h.slot.querySelector<HTMLButtonElement>('[data-cloud-panel-consent-answer="allow"]')!.disabled).toBe(false);
    expect(h.frame().src).not.toContain("cloud_panel_context");
  });

  test("a failed repeated approval clears previously delivered context before forgetting the answer", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Offline"));
    const h = setupContext(pageContext, true, true);
    h.open();
    const post = spyFrame(h);
    ready(h);
    consent("fixture", true);
    await tick();
    expect(post.mock.calls.at(-1)?.[0]).toEqual({ type: "cloud.panel.context", v: 1, context: null });
    expect(h.slot.dataset.consent).toBe("ask");
    h.click("[data-cloud-panel-retry]");
    expect(h.frame().src).not.toContain("cloud_panel_context");
  });
}
