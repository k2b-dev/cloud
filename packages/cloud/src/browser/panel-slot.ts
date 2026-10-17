import { attachResizeSeparator, parkWorkspaceDetailDrawers } from "@k2b/ui";
import { PANEL_MAX_WIDTH_REM, PANEL_MIN_WIDTH_REM, readPanelCookie, serializePanelCookie } from "../_internal/panel-cookie";
import { platformMessages } from "../ssr/platform-messages";
import { readShellData } from "../ssr/shell-data";
import type { PanelRequest } from "./panel";
import { isPanelCloseMessage, isPanelReadyMessage } from "./panel-messages";

export const PANEL_READY_TIMEOUT_MS = 10_000;
let installed: { dispose: () => void; request: (request: PanelRequest) => void } | undefined;

export function handlePanelRequest(request: PanelRequest): void {
  installed?.request(request);
}

/** Owns the slot's single iframe, independently persisted desktop and transient phone state. */
export function installPanelSlot(): () => void {
  if (installed) return installed.dispose;
  const canvas = document.querySelector<HTMLElement>(".cloud-app-canvas");
  const slot = document.getElementById("cloud-panel");
  const body = slot?.querySelector<HTMLElement>(".cloud-panel__body");
  const panel = readShellData()?.panel;
  if (!canvas || !slot || !body || !panel?.providers.length) return () => {};
  const t = platformMessages.resolve([document.documentElement.lang || "en"]).t;
  // The mode uses the same px breakpoint as panel.css and the shell, read fresh, so CSS and the controller always
  // agree; `phoneChange` only tells when to look again.
  const isPhone = () => !window.matchMedia("(min-width: 768px)").matches;
  const phoneChange = window.matchMedia("(max-width: 767.98px)");
  const column = window.matchMedia("(min-width: 1024px)");
  const attribute = () => (isPhone() ? "data-panel-sheet" : "data-panel");
  const isOpen = () => canvas.getAttribute(attribute()) === "open";
  const status = slot.querySelector<HTMLElement>("[data-cloud-panel-status]");
  const separator = slot.querySelector<HTMLElement>(".cloud-panel__resize");
  const tabs = [...slot.querySelectorAll<HTMLButtonElement>("[data-cloud-panel-provider]")];
  const grow = slot.querySelector<HTMLButtonElement>("[data-cloud-panel-grow]");
  let provider = panel.providers.find((item) => item.id === slot.dataset.provider) ?? panel.providers[0]!;
  let frame = slot.querySelector<HTMLIFrameElement>("[data-cloud-panel-frame]");
  let search: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let opener: HTMLElement | undefined;
  const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const storedWidth = parseFloat(canvas.style.getPropertyValue("--cloud-panel-width-set"));
  let committedWidth = Number.isFinite(storedWidth) ? storedWidth : undefined;
  let width = committedWidth ?? PANEL_MIN_WIDTH_REM;
  const setWidth = (value: number) => {
    width = value;
    canvas.style.setProperty("--cloud-panel-width-set", `${value}rem`);
    separator?.setAttribute("aria-valuenow", String(Math.round(value * 100) / 100));
  };
  const seedWidth = () => {
    if (committedWidth !== undefined || !column.matches || !isOpen()) return;
    const measured = slot.getBoundingClientRect().width / rem();
    if (measured > 0) width = Math.min(PANEL_MAX_WIDTH_REM, Math.max(PANEL_MIN_WIDTH_REM, measured));
    separator?.setAttribute("aria-valuenow", String(Math.round(width * 100) / 100));
  };
  // Another tab may have saved a newer width; opening or closing keeps it instead of writing back an old one.
  const adoptStoredWidth = (apply: boolean) => {
    const stored = readPanelCookie(
      document.cookie,
      panel.providers.map((item) => item.id),
    ).widthRem;
    if (stored === undefined) return;
    committedWidth = stored;
    if (apply && stored !== width) setWidth(stored);
  };
  const writeCookie = () => {
    if (isPhone()) return;
    document.cookie = serializePanelCookie(
      { open: canvas.dataset.panel === "open", provider: provider.id, widthRem: committedWidth },
      location.protocol === "https:",
    );
  };
  const update = () => {
    for (const button of document.querySelectorAll("[data-cloud-panel-toggle]")) button.setAttribute("aria-expanded", String(isOpen()));
    for (const tab of tabs) {
      const selected = tab.dataset.cloudPanelProvider === provider.id;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    const description = slot.querySelector<HTMLElement>(".k2b-placeholder__description");
    if (description) description.textContent = t.panelNotResponding({ label: provider.label });
  };
  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const loading = () => {
    clearTimer();
    slot.dataset.state = "loading";
    if (status) status.textContent = t.panelLoading({ label: provider.label });
    timer = setTimeout(() => {
      slot.dataset.state = "failed";
      if (status) status.textContent = `${t.panelLoadFailed}. ${t.panelNotResponding({ label: provider.label })}`;
    }, PANEL_READY_TIMEOUT_MS);
  };
  const markReady = () => {
    clearTimer();
    slot.dataset.state = "ready";
    if (status) status.textContent = "";
  };
  const unload = () => {
    clearTimer();
    frame?.remove();
    frame = null;
    slot.dataset.state = "closed";
    if (status) status.textContent = "";
  };
  const load = (replace = false) => {
    const url = new URL(provider.href, location.origin);
    if (search !== undefined) url.search = search;
    if (!replace && frame?.src === url.href) return;
    frame?.remove();
    frame = document.createElement("iframe");
    frame.className = "cloud-panel__frame";
    frame.title = provider.label;
    frame.dataset.cloudPanelFrame = provider.id;
    frame.src = `${url.pathname}${url.search}${url.hash}`;
    loading();
    body.append(frame);
  };
  let removeFallbackFocus = () => {};
  const returnFocus = () => {
    if (opener?.isConnected && opener.getClientRects().length && !opener.closest("[inert]")) {
      opener.focus();
      if (document.activeElement === opener) return;
    }
    const main = canvas.querySelector<HTMLElement>("[data-cloud-app-area] main.layout-content-main, main[data-cloud-app-area]");
    if (!main) return;
    removeFallbackFocus();
    if (!main.hasAttribute("tabindex")) {
      main.tabIndex = -1;
      removeFallbackFocus = () => {
        main.removeAttribute("tabindex");
        main.removeEventListener("blur", removeFallbackFocus);
      };
      main.addEventListener("blur", removeFallbackFocus, { once: true });
    }
    main.focus();
  };
  const close = () => {
    if (!isOpen()) return;
    canvas.removeAttribute(attribute());
    disposeResize();
    disposeResize = attachResize();
    unload();
    adoptStoredWidth(false);
    writeCookie();
    update();
    returnFocus();
  };
  const open = (id: string, nextSearch?: string) => {
    const next = panel.providers.find((item) => item.id === id);
    if (!next) return;
    parkWorkspaceDetailDrawers(document);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !slot.contains(active)) opener = active;
    provider = next;
    search = typeof nextSearch === "string" && nextSearch.length <= 2048 ? nextSearch : undefined;
    canvas.setAttribute(attribute(), "open");
    slot.dataset.provider = provider.id;
    adoptStoredWidth(true);
    seedWidth();
    load();
    writeCookie();
    update();
    frame?.focus();
  };
  const request = (request: PanelRequest) => {
    if (request.action === "open") open(request.provider, request.search);
    else if (request.action === "close" || isOpen()) close();
    else open(provider.id, search);
  };
  const message = (event: MessageEvent<unknown>) => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return;
    if (isPanelReadyMessage(event.data, provider.id)) markReady();
    else if (isPanelCloseMessage(event.data)) close();
  };
  const click = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-cloud-panel-close]")) close();
    else if (event.target.closest("[data-cloud-panel-retry]") && isOpen()) {
      load(true);
      frame?.focus();
    } else if (event.target.closest("[data-cloud-panel-grow]") && isPhone()) {
      const full = slot.dataset.panelSize !== "full";
      if (full) slot.dataset.panelSize = "full";
      else delete slot.dataset.panelSize;
      grow?.setAttribute("aria-label", full ? t.shrinkPanel : t.enlargePanel);
    } else {
      const tab = event.target.closest<HTMLElement>("[data-cloud-panel-provider]");
      if (tab?.dataset.cloudPanelProvider) open(tab.dataset.cloudPanelProvider);
    }
  };
  const key = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!(event.target instanceof Element) || !slot.contains(event.target)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const index = tabs.findIndex((tab) => tab === event.target);
    if (index < 0) return;
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return; // Buttons activate with native Enter/Space clicks.
    event.preventDefault();
    for (const [index, tab] of tabs.entries()) tab.tabIndex = index === next ? 0 : -1;
    tabs[next]?.focus();
  };
  const modeChange = () => {
    disposeResize();
    if (isOpen()) {
      seedWidth();
      load();
    } else unload();
    disposeResize = attachResize();
    update();
  };
  const closeSheet = () => {
    const wasOpen = canvas.dataset.panelSheet === "open";
    canvas.removeAttribute("data-panel-sheet");
    if (wasOpen && isPhone()) {
      unload();
      update();
    }
  };
  const pageShow = (event: PageTransitionEvent) => {
    if (event.persisted) closeSheet();
  };
  let dragWidth = width;
  let dragStoredWidth = committedWidth;
  let dragInlineWidth = "";
  const restoreDragWidth = () => {
    width = dragWidth;
    committedWidth = dragStoredWidth;
    if (dragInlineWidth) canvas.style.setProperty("--cloud-panel-width-set", dragInlineWidth);
    else canvas.style.removeProperty("--cloud-panel-width-set");
    separator?.setAttribute("aria-valuenow", String(Math.round(width * 100) / 100));
  };
  let endingDrag = false;
  seedWidth();
  const attachResize = () =>
    separator && column.matches
      ? attachResizeSeparator(separator, {
          min: PANEL_MIN_WIDTH_REM,
          max: PANEL_MAX_WIDTH_REM,
          value: () => width,
          get unit() {
            return rem();
          },
          step: 1,
          largeStep: 4,
          grow: "start",
          collapseBelow: 16,
          onResize: (value) => {
            if (endingDrag) {
              endingDrag = false;
              restoreDragWidth();
            } else setWidth(value);
          },
          onResizeEnd: (value) => {
            endingDrag = false;
            committedWidth = value;
            writeCookie();
          },
          onCollapseIntent: (armed) => {
            if (armed) slot.dataset.closing = "true";
            else delete slot.dataset.closing;
          },
          onCollapse: () => {
            endingDrag = false;
            restoreDragWidth();
            close();
          },
          onDragChange: (dragging) => {
            if (dragging) {
              dragWidth = width;
              dragStoredWidth = committedWidth;
              dragInlineWidth = canvas.style.getPropertyValue("--cloud-panel-width-set");
              slot.dataset.resizing = "true";
            } else {
              delete slot.dataset.resizing;
              endingDrag = true;
            }
          },
        })
      : () => {};
  let disposeResize = attachResize();
  window.addEventListener("message", message);
  window.addEventListener("keydown", key);
  slot.addEventListener("click", click);
  phoneChange.addEventListener("change", modeChange);
  column.addEventListener("change", modeChange);
  window.addEventListener("pageshow", pageShow);
  window.addEventListener("popstate", closeSheet);
  window.addEventListener("resize", seedWidth);
  // An SSR iframe can have posted its one-shot ready before this lazy module
  // arrived. Its runtime also marks its own same-origin document, so read that
  // once the listener is in place instead of loading the provider again.
  if (isOpen() && frame) {
    if (frame.contentDocument?.documentElement.dataset.cloudPanelReady === provider.id) markReady();
    else loading();
  } else if (isOpen()) load();
  else unload();
  update();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimer();
    disposeResize();
    removeFallbackFocus();
    window.removeEventListener("message", message);
    window.removeEventListener("keydown", key);
    slot.removeEventListener("click", click);
    phoneChange.removeEventListener("change", modeChange);
    column.removeEventListener("change", modeChange);
    window.removeEventListener("pageshow", pageShow);
    window.removeEventListener("popstate", closeSheet);
    window.removeEventListener("resize", seedWidth);
    installed = undefined;
  };
  installed = { dispose, request };
  return dispose;
}
