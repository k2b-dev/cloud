import { attachResizeSeparator, parkWorkspaceDetailDrawers } from "@k2b/ui";
import { PANEL_MAX_WIDTH_REM, PANEL_MIN_WIDTH_REM, readPanelCookie, serializePanelCookie } from "../_internal/panel-cookie";
import { CloudResourceRefSchema } from "../contracts/capabilities";
import { withPanelContext } from "../contracts/panel-context";
import { platformMessages } from "../ssr/platform-messages";
import { readShellData } from "../ssr/shell-data";
import type { PanelRequest } from "./panel";
import {
  PAGE_CONTEXT_CHANGED,
  PAGE_CONTEXT_COLLECT,
  type PageContextCollection,
  type PanelConsentRequest,
  type PanelState,
} from "./panel-context-bridge";
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
  let disposed = false;
  let context = panel.context ?? null;
  let loadVersion = 0;
  const answers = new Map<string, boolean | null>();
  if (panel.consent) answers.set(panel.consent.provider, panel.consent.allowed);
  const saving = new Set<string>();
  const errors = new Set<string>();
  const requests = new AbortController();
  let answersRequest: Promise<void> | undefined;
  const allowed = () => !provider.consent || answers.get(provider.id) === true;
  const sendContext = () => {
    if (isOpen() && allowed() && context && slot.dataset.state === "ready")
      frame?.contentWindow?.postMessage({ type: "cloud.panel.context", v: 1, context }, location.origin);
  };
  const clearContext = () => {
    if (allowed() && panel.context)
      frame?.contentWindow?.postMessage({ type: "cloud.panel.context", v: 1, context: null }, location.origin);
  };
  const collectContext = () => {
    if (!context) return;
    const collection: PageContextCollection = { sources: [] };
    window.dispatchEvent(new CustomEvent(PAGE_CONTEXT_COLLECT, { detail: collection }));
    const source = collection.sources.findLast((source) => source.scope !== undefined);
    const parsed = source ? CloudResourceRefSchema.safeParse(source.scope) : undefined;
    const scope = source ? (parsed?.success ? parsed.data : undefined) : panel.context?.scope;
    if (scope?.type === context.scope?.type && scope?.id === context.scope?.id) return;
    const { scope: _previous, ...base } = context;
    context = { ...base, seq: context.seq + 1, ...(scope ? { scope } : {}) };
    sendContext();
  };
  const readAnswers = () => {
    answersRequest ??= (async () => {
      try {
        const response = await fetch("/api/me/panel-consent", {
          cache: "no-store",
          signal: AbortSignal.any([requests.signal, AbortSignal.timeout(PANEL_READY_TIMEOUT_MS)]),
        });
        if (!response.ok) throw new Error("Panel consent unavailable");
        const data: unknown = await response.json();
        if (data && typeof data === "object" && "answers" in data && data.answers && typeof data.answers === "object") {
          for (const item of panel.providers) {
            const value: unknown = Reflect.get(data.answers, item.id);
            if (!answers.has(item.id) && typeof value === "boolean") answers.set(item.id, value);
          }
        }
      } catch {
        // No answer is fail closed, including an unavailable store or an aborted request.
      }
      for (const item of panel.providers) if (!answers.has(item.id)) answers.set(item.id, null);
    })();
    return answersRequest;
  };
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
    if (isPhone() || canvas.hasAttribute("data-panel-transient")) return;
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
    slot.dataset.appName = provider.appName;
    slot.dataset.providerConsent = String(provider.consent);
    slot.dataset.contextAllowed = String(allowed());
    slot.dataset.consentSaving = String(saving.has(provider.id));
    const ask =
      isOpen() && provider.consent && ((answers.has(provider.id) && answers.get(provider.id) === null) || errors.has(provider.id));
    if (ask) slot.dataset.consent = "ask";
    else delete slot.dataset.consent;
    const title = slot.querySelector<HTMLElement>("[data-cloud-panel-consent-title]");
    const text = slot.querySelector<HTMLElement>("[data-cloud-panel-consent-body]");
    const error = slot.querySelector<HTMLElement>("[data-cloud-panel-consent-error]");
    if (title) title.textContent = t.panelConsentTitle({ app: provider.appName });
    if (text) text.textContent = t.panelConsentBody({ app: provider.appName });
    if (error) error.textContent = errors.has(provider.id) ? t.panelConsentSaveError : "";
    for (const button of slot.querySelectorAll<HTMLButtonElement>("[data-cloud-panel-consent-answer]"))
      button.disabled = saving.has(provider.id);
    window.dispatchEvent(
      new CustomEvent<PanelState>("cloud.panel.state", {
        detail: {
          provider: provider.id,
          appName: provider.appName,
          consent: provider.consent,
          allowed: allowed(),
          saving: saving.has(provider.id),
        },
      }),
    );
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
    sendContext();
  };
  const unload = () => {
    ++loadVersion;
    clearContext();
    clearTimer();
    frame?.remove();
    frame = null;
    slot.dataset.state = "closed";
    if (status) status.textContent = "";
  };
  const target = () => {
    const url = new URL(provider.href, location.origin);
    if (search !== undefined) url.search = search;
    if (url.origin === location.origin) {
      const path = withPanelContext(`${url.pathname}${url.search}${url.hash}`, allowed() ? context : null);
      return new URL(path, location.origin);
    }
    return url;
  };
  // The page the iframe shows now; a reader may have moved on inside the panel since it loaded.
  const shownHref = () => {
    try {
      return frame?.contentWindow?.location.href;
    } catch {
      return undefined;
    }
  };
  const loadNow = (replace = false) => {
    const url = target();
    if (!replace && frame?.src === url.href) return;
    clearContext();
    frame?.remove();
    // The server validates every provider path; the iframe still never leaves this origin.
    if (url.origin !== location.origin) {
      frame = null;
      clearTimer();
      slot.dataset.state = "failed";
      return;
    }
    frame = document.createElement("iframe");
    frame.className = "cloud-panel__frame";
    frame.title = provider.label;
    frame.dataset.cloudPanelFrame = provider.id;
    frame.src = url.href;
    loading();
    body.append(frame);
  };
  const load = (replace = false) => {
    const version = ++loadVersion;
    if (provider.consent && !answers.has(provider.id)) {
      clearContext();
      frame?.remove();
      frame = null;
      loading();
      clearTimer(); // The consent read has its own bounded timeout; provider readiness starts with its load.
      void readAnswers().then(() => {
        if (disposed || !isOpen() || version !== loadVersion) return;
        loadNow(replace);
        update();
      });
    } else loadNow(replace);
  };
  const saveConsent = async (request: PanelConsentRequest) => {
    const item = panel.providers.find((item) => item.id === request.provider && item.consent);
    if (!item || typeof request.allowed !== "boolean" || saving.has(item.id)) return;
    saving.add(item.id);
    errors.delete(item.id);
    // Withdrawal stops disclosure immediately, including while the idempotent save is in flight.
    if (!request.allowed) {
      if (provider.id === item.id) clearContext();
      answers.set(item.id, false);
    }
    update();
    try {
      const response = await fetch(`/api/me/panel-consent/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowed: request.allowed }),
        signal: AbortSignal.any([requests.signal, AbortSignal.timeout(PANEL_READY_TIMEOUT_MS)]),
      });
      if (!response.ok) throw new Error("Panel consent was not saved");
      const saved: unknown = await response.json();
      if (
        !saved ||
        typeof saved !== "object" ||
        !("provider" in saved) ||
        saved.provider !== item.id ||
        !("allowed" in saved) ||
        saved.allowed !== request.allowed
      )
        throw new Error("Invalid panel consent answer");
      if (disposed) return;
      answers.set(item.id, request.allowed);
      const questionHadFocus = slot.querySelector("[data-cloud-panel-consent]")?.contains(document.activeElement);
      update();
      if (provider.id === item.id && isOpen() && questionHadFocus) frame?.focus();
      if (provider.id === item.id && request.allowed) sendContext();
    } catch {
      if (disposed) return;
      if (provider.id === item.id) clearContext();
      answers.set(item.id, null);
      errors.add(item.id);
    } finally {
      saving.delete(item.id);
      if (!disposed) update();
    }
  };
  const consentRequest = (event: CustomEvent<PanelConsentRequest>) => {
    void saveConsent(event.detail);
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
    if (provider.id !== next.id) unload();
    provider = next;
    search = typeof nextSearch === "string" && nextSearch.length <= 2048 ? nextSearch : undefined;
    canvas.setAttribute(attribute(), "open");
    slot.dataset.provider = provider.id;
    adoptStoredWidth(true);
    seedWidth();
    // A requested search is a destination: it replaces a page reached inside the panel.
    const shown = shownHref();
    load(search !== undefined && shown !== undefined && shown !== "about:blank" && shown !== target().href);
    writeCookie();
    update();
    // An open question takes focus first, so the reader hears it before the provider page.
    if (slot.dataset.consent === "ask") slot.querySelector<HTMLElement>("[data-cloud-panel-consent]")?.focus();
    else frame?.focus();
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
    const answer = event.target.closest<HTMLElement>("[data-cloud-panel-consent-answer]");
    if (answer && isOpen()) void saveConsent({ provider: provider.id, allowed: answer.dataset.cloudPanelConsentAnswer === "allow" });
    else if (event.target.closest("[data-cloud-panel-close]")) close();
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
  const entryChange = (event: NavigationCurrentEntryChangeEvent) => {
    if (event.navigationType === "push") closeSheet();
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
  collectContext();
  window.addEventListener(PAGE_CONTEXT_CHANGED, collectContext);
  window.addEventListener("cloud.panel.consent", consentRequest);
  window.addEventListener("message", message);
  window.addEventListener("keydown", key);
  slot.addEventListener("click", click);
  phoneChange.addEventListener("change", modeChange);
  column.addEventListener("change", modeChange);
  window.addEventListener("pageshow", pageShow);
  window.addEventListener("popstate", closeSheet);
  window.navigation?.addEventListener("currententrychange", entryChange);
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
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    requests.abort();
    ++loadVersion;
    clearContext();
    clearTimer();
    disposeResize();
    removeFallbackFocus();
    window.removeEventListener(PAGE_CONTEXT_CHANGED, collectContext);
    window.removeEventListener("cloud.panel.consent", consentRequest);
    window.removeEventListener("message", message);
    window.removeEventListener("keydown", key);
    slot.removeEventListener("click", click);
    phoneChange.removeEventListener("change", modeChange);
    column.removeEventListener("change", modeChange);
    window.removeEventListener("pageshow", pageShow);
    window.removeEventListener("popstate", closeSheet);
    window.navigation?.removeEventListener("currententrychange", entryChange);
    window.removeEventListener("resize", seedWidth);
    installed = undefined;
  };
  installed = { dispose, request };
  return dispose;
}
