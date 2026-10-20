import { attachResizeSeparator, LocaleProvider, parkWorkspaceDetailDrawers } from "@k2b/ui";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { PANEL_MAX_WIDTH_REM, PANEL_MIN_WIDTH_REM, readPanelCookie, serializePanelCookie } from "../_internal/panel-cookie";
import { CloudResourceRefSchema } from "../contracts/capabilities";
import type { PanelPageContext } from "../contracts/panel-context";
import {
  isPanelPageContext,
  isPanelShortcut,
  PANEL_CONTEXT_PARAM,
  panelProviderNeedsConsent,
  withPanelContext,
} from "../contracts/panel-context-plain";
import { helpShortcutGroups } from "../ssr/layout-help-start";
import { platformMessages } from "../ssr/platform-messages";
import { readShellData } from "../ssr/shell-data";
import { COMMANDS_CHANGED, contextCommandsWithShortcuts } from "./command-shortcuts";
import type { PanelRequest } from "./panel";
import {
  PAGE_CONTEXT_CHANGED,
  PAGE_CONTEXT_COLLECT,
  type PageContextCollection,
  type PanelConsentRequest,
  type PanelState,
} from "./panel-context-bridge";
import PanelMenu from "./panel-menu";
import { isPanelCloseMessage, isPanelReadyMessage, isPanelSearchMessage } from "./panel-messages";
import { importOnDemand } from "./reload";

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
  const lang = document.documentElement.lang || "en";
  const t = platformMessages.resolve([lang]).t;
  const menuHost = slot.querySelector<HTMLElement>("[data-cloud-panel-menu]");
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
  let base = panel.context ?? null;
  let context = base;
  let pageRoot = document.querySelector("[data-nav-root]");
  let documentPageId = context?.pageId;
  let lastSeq = context?.seq ?? 0;
  // The retained provider may have locked onto this document before a swap and this lazy installer.
  try {
    const raw = frame && new URL(frame.src, location.href).searchParams.get(PANEL_CONTEXT_PARAM);
    const initial: unknown = raw ? JSON.parse(raw) : null;
    if (isPanelPageContext(initial)) {
      documentPageId = initial.pageId;
      lastSeq = context?.pageId === documentPageId ? Math.max(lastSeq, initial.seq) : initial.seq;
      if (context && context.pageId !== documentPageId) context = { ...context, pageId: documentPageId, seq: ++lastSeq };
    }
  } catch {
    // A malformed or absent URL context leaves the shown page's context in charge.
  }
  // Set when a swapped page's context has not been delivered yet; cleared by the next delivery.
  let pageUnsent = false;
  const followPage = () => {
    const nextRoot = document.querySelector("[data-nav-root]");
    if (nextRoot === pageRoot) return;
    pageRoot = nextRoot;
    pageUnsent = true;
    const arriving = readShellData()?.panel;
    // The arriving page carries the server's current consent answer, as a reload would; a newer revision wins.
    const consent = arriving?.consent;
    if (consent && consent.provider === provider.id) {
      if (consent.revision > (revisions.get(consent.provider) ?? 0)) {
        answers.set(consent.provider, consent.allowed);
        revisions.set(consent.provider, consent.revision);
      } else if (consent.allowed !== answers.get(consent.provider) || consent.revision !== revisions.get(consent.provider)) {
        // An older or unreadable answer (`allowed: null`) is what a reload would show: stop and read again.
        void revalidate();
      }
    } else if (provider.consent && isOpen()) {
      // The server sends an answer only while the shared cookie shows this provider open; without it, read again.
      void revalidate();
    } else if (consentPending === 0) {
      // A reload would read these answers again when a consent provider opens; so does the next open here.
      for (const item of panel.providers) if (item.consent) answers.delete(item.id);
      answersRead = undefined;
    }
    base = arriving?.context ?? null;
    if (base) {
      documentPageId ??= base.pageId;
      context = { ...base, pageId: documentPageId, seq: ++lastSeq };
    } else context = null;
  };
  let loadVersion = 0;
  const answers = new Map<string, boolean | null>();
  const revisions = new Map<string, number>();
  if (panel.consent) {
    answers.set(panel.consent.provider, panel.consent.allowed);
    revisions.set(panel.consent.provider, panel.consent.revision);
  }
  const saving = new Set<string>();
  const errors = new Set<string>();
  const requests = new AbortController();
  /*
   * Consent reads and writes run one at a time, in order, and sharing with a provider that needs consent is blocked
   * while any of them is pending or the answers are stale (a back/forward restore). Server revisions also fence
   * writes still running after a client timeout; only a settled, current `true` lets context through.
   */
  let consentQueue: Promise<void> = Promise.resolve();
  let consentPending = 0;
  let answersStale = false;
  // A save that failed or timed out has an unknown outcome on the server: nothing is shared until the person answers again.
  const allowed = () =>
    !provider.consent || (consentPending === 0 && !answersStale && !errors.has(provider.id) && answers.get(provider.id) === true);
  // Whether the current frame has seen a context, in its URL or by message; only such a frame needs a clearing null.
  let disclosed = !!frame && new URL(frame.src, location.origin).searchParams.has(PANEL_CONTEXT_PARAM);
  // The frame may have navigated on its own; only the selected provider's page below its panel path may receive context.
  const showsProvider = () => {
    try {
      const shown = frame?.contentWindow?.location;
      const scope = new URL(provider.href, location.origin).pathname.replace(/\/$/, "");
      return (
        !!shown &&
        frame?.contentDocument?.documentElement.dataset.cloudPanelReady === provider.id &&
        (shown.pathname === scope || shown.pathname.startsWith(`${scope}/`))
      );
    } catch {
      return false;
    }
  };
  const shortcuts = () =>
    helpShortcutGroups(contextCommandsWithShortcuts())
      .flatMap((group) =>
        group.shortcuts.map(({ id, title, description, shortcut, scope }) => ({
          id,
          title,
          ...(description ? { description } : {}),
          shortcut,
          ...(scope === "selection" || scope === "page" ? { scope } : {}),
        })),
      )
      .filter(isPanelShortcut);
  let lastShortcutsJson: string | undefined;
  const canSend = () => isOpen() && allowed() && !!context && slot.dataset.state === "ready" && !!frame?.contentWindow && showsProvider();
  const sendContext = () => {
    pageUnsent = false;
    if (!canSend()) return;
    const list = !panelProviderNeedsConsent(provider.id) ? shortcuts() : undefined;
    frame?.contentWindow?.postMessage(
      { type: "cloud.panel.context", v: 1, context, ...(list ? { shortcuts: list } : {}) },
      location.origin,
    );
    if (list) lastShortcutsJson = JSON.stringify(list);
    disclosed = true;
    // A reload of the provider page renders from its address, so the address follows the live context.
    syncUrlContext(context);
  };
  const postNull = () => {
    frame?.contentWindow?.postMessage({ type: "cloud.panel.context", v: 1, context: null }, location.origin);
    lastShortcutsJson = undefined;
  };
  let shortcutsPending = false;
  const commandsChanged = () => {
    if (shortcutsPending) return;
    shortcutsPending = true;
    queueMicrotask(() => {
      shortcutsPending = false;
      if (disposed || panelProviderNeedsConsent(provider.id) || !canSend()) return;
      if (JSON.stringify(shortcuts()) !== lastShortcutsJson) sendContext();
    });
  };
  const clearContext = () => {
    if (disclosed) postNull();
  };
  // The provider's address carries the snapshot its server renders on reload: it follows sharing in both directions.
  // True when the provider's current address now matches; false while its document is not reachable yet.
  function syncUrlContext(next: PanelPageContext | null): boolean {
    try {
      const shown = frame?.contentWindow;
      if (!shown || (next && !showsProvider())) return false;
      const current = `${shown.location.pathname}${shown.location.search}${shown.location.hash}`;
      const path = withPanelContext(current, next);
      if (path !== current) shown.history.replaceState(shown.history.state, "", path);
      return true;
    } catch {
      // Not yet a same-origin document (about:blank, a pending navigation); its ready handshake clears it.
      return false;
    }
  }
  // A withdrawn answer must not come back when the provider reloads its own document: the URL snapshot goes too.
  const forgetUrlContext = () => syncUrlContext(null);
  const stopSharing = () => {
    if (!disclosed) return;
    postNull();
    // Only a frame whose address is clean holds nothing any more; otherwise ready cleans it up later.
    if (forgetUrlContext()) disclosed = false;
  };
  const collectContext = () => {
    followPage();
    if (!context) return;
    const collection: PageContextCollection = { sources: [] };
    window.dispatchEvent(new CustomEvent(PAGE_CONTEXT_COLLECT, { detail: collection }));
    const source = collection.sources.findLast((source) => source.scope !== undefined);
    const parsed = source ? CloudResourceRefSchema.safeParse(source.scope) : undefined;
    const scope = source ? (parsed?.success ? parsed.data : undefined) : base?.scope;
    if (scope?.type === context.scope?.type && scope?.id === context.scope?.id) return;
    const { scope: _previous, ...previous } = context;
    context = { ...previous, seq: ++lastSeq, ...(scope ? { scope } : {}) };
    sendContext();
  };
  // Share or stop sharing after every consent step; an open question or its absence follows in update().
  const reconcile = () => {
    if (disposed) return;
    update();
    if (allowed()) sendContext();
    else if (provider.consent) stopSharing();
  };
  const enqueueConsent = (step: () => Promise<void>) => {
    consentPending += 1;
    reconcile();
    const run = consentQueue.then(step).finally(() => {
      consentPending -= 1;
      reconcile();
    });
    consentQueue = run.catch(() => {});
    return run;
  };
  // Replaces every answer of providers that need consent; a failed read leaves them unanswered (fail closed).
  const readAnswersNow = async () => {
    const next = new Map<string, boolean | null>();
    const nextRevisions = new Map<string, number>();
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
          if (
            value &&
            typeof value === "object" &&
            "allowed" in value &&
            typeof value.allowed === "boolean" &&
            "revision" in value &&
            typeof value.revision === "number" &&
            Number.isInteger(value.revision) &&
            value.revision > 0
          ) {
            next.set(item.id, value.allowed);
            nextRevisions.set(item.id, value.revision);
          }
        }
      }
    } catch {
      // No answer is fail closed, including an unavailable store or an aborted request.
    }
    for (const item of panel.providers) {
      if (!item.consent) continue;
      answers.set(item.id, next.get(item.id) ?? null);
      revisions.set(item.id, nextRevisions.get(item.id) ?? 0);
    }
    answersStale = false;
  };
  let answersRead: Promise<void> | undefined;
  const readAnswers = () => {
    answersRead ??= enqueueConsent(readAnswersNow);
    return answersRead;
  };
  // A restored page may hold answers changed elsewhere meanwhile: stop sharing now and read them again in order.
  const revalidate = () => {
    answersStale = true;
    answersRead = enqueueConsent(readAnswersNow);
    return answersRead;
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
    if (menuHost) {
      menuHost.style.visibility = provider.consent ? "visible" : "hidden";
      menuHost.inert = !provider.consent;
    }
    window.dispatchEvent(
      new CustomEvent<PanelState>("cloud.panel.state", {
        detail: {
          provider: provider.id,
          appName: provider.appName,
          consent: provider.consent,
          allowed: allowed(),
          saving: saving.has(provider.id),
          open: isOpen(),
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
    if (allowed() && context) {
      sendContext();
      return;
    }
    // The arriving document may carry a snapshot this controller never cleaned (a navigation that was already under
    // way at withdrawal, a reload): look at the document itself, not only at what the last one saw.
    let carries = disclosed;
    try {
      carries ||= new URL(frame?.contentWindow?.location.href ?? "about:blank").searchParams.has(PANEL_CONTEXT_PARAM);
    } catch {
      carries = true;
    }
    if (carries) {
      postNull();
      disclosed = !forgetUrlContext();
    }
  };
  const unload = () => {
    ++loadVersion;
    focusPending = false;
    clearContext();
    clearTimer();
    frame?.remove();
    frame = null;
    lastShortcutsJson = undefined;
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
  // The context snapshot in the URL is not the provider's destination: a frame that got newer context live stays.
  const destination = (href: string) => {
    const url = new URL(href, location.origin);
    return url.origin === location.origin ? withPanelContext(`${url.pathname}${url.search}${url.hash}`, null) : url.href;
  };
  const loadNow = (replace = false) => {
    const url = target();
    if (!replace && frame && destination(frame.src) === destination(url.href)) return;
    clearContext();
    frame?.remove();
    lastShortcutsJson = undefined;
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
    disclosed = url.searchParams.has(PANEL_CONTEXT_PARAM);
    loading();
    body.append(frame);
  };
  const load = (replace = false) => {
    const version = ++loadVersion;
    if (provider.consent && !answers.has(provider.id)) {
      clearContext();
      frame?.remove();
      frame = null;
      lastShortcutsJson = undefined;
      loading();
      clearTimer(); // The consent read has its own bounded timeout; provider readiness starts with its load.
      void readAnswers().then(() => {
        if (disposed || !isOpen() || version !== loadVersion) return;
        loadNow(replace);
        update();
        // open() could not move focus while nothing was there; do it now unless the reader moved on meanwhile.
        const active = document.activeElement;
        if (focusPending && (active === document.body || active === opener || slot.contains(active))) focusPanel();
        focusPending = false;
      });
    } else loadNow(replace);
  };
  const saveConsent = (request: PanelConsentRequest) => {
    const item = panel.providers.find((item) => item.id === request.provider && item.consent);
    if (!item || typeof request.allowed !== "boolean" || saving.has(item.id)) return;
    saving.add(item.id);
    errors.delete(item.id);
    const questionHadFocus = slot.querySelector("[data-cloud-panel-consent]")?.contains(document.activeElement);
    // Enqueueing blocks sharing at once, so a withdrawal stops disclosure before its save even starts.
    // keepalive: leaving the page does not cancel the save. A save the browser gives up on (timeout) is rolled back
    // by the server, so no answer lands after this page stopped waiting for it.
    const put = () =>
      fetch(`/api/me/panel-consent/${encodeURIComponent(item.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowed: request.allowed, revision: revisions.get(item.id) ?? 0 }),
        keepalive: true,
        signal: AbortSignal.timeout(PANEL_READY_TIMEOUT_MS),
      });
    void enqueueConsent(async () => {
      try {
        let response = await put();
        // Changed meanwhile (another tab, or a read that failed): the person's choice now is the newest one, so read
        // the current revision and save it once more. A second conflict shows the question again.
        if (response.status === 409) {
          await readAnswersNow();
          response = await put();
        }
        if (!response.ok) throw new Error("Panel consent was not saved");
        const saved: unknown = await response.json();
        if (
          !saved ||
          typeof saved !== "object" ||
          !("provider" in saved) ||
          saved.provider !== item.id ||
          !("allowed" in saved) ||
          saved.allowed !== request.allowed ||
          !("revision" in saved) ||
          typeof saved.revision !== "number" ||
          !Number.isInteger(saved.revision) ||
          saved.revision <= 0
        )
          throw new Error("Invalid panel consent answer");
        answers.set(item.id, request.allowed);
        revisions.set(item.id, saved.revision);
      } catch {
        // Not saved: nothing is shared until the person answers again; the read learns the current revision.
        errors.add(item.id);
        await readAnswersNow();
        answers.set(item.id, null);
      } finally {
        saving.delete(item.id);
      }
    }).then(() => {
      if (disposed) return;
      // Move on into the provider only if the reader is still at the question (or nowhere), not after they moved on.
      const active = document.activeElement;
      const stillHere = active === document.body || !!slot.querySelector("[data-cloud-panel-consent]")?.contains(active);
      if (provider.id === item.id && isOpen() && questionHadFocus && stillHere && slot.dataset.consent !== "ask") frame?.focus();
    });
  };
  const consentRequest = (event: CustomEvent<PanelConsentRequest>) => {
    void saveConsent(event.detail);
  };
  let focusPending = false;
  // An open question takes focus first, so the reader hears it before the provider page.
  const focusPanel = () => {
    if (slot.dataset.consent === "ask") slot.querySelector<HTMLElement>("[data-cloud-panel-consent]")?.focus();
    else frame?.focus();
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
    focusPending = false;
    load(search !== undefined && shown !== undefined && shown !== "about:blank" && destination(shown) !== destination(target().href));
    writeCookie();
    update();
    if (frame) focusPanel();
    else focusPending = true;
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
    else if (isPanelSearchMessage(event.data)) {
      const command = contextCommandsWithShortcuts().find((command) => command.id === "cloud.search" && command.shortcut);
      if (command) void importOnDemand(() => import("./commands")).then((commands) => commands?.runContextAwareCommand(command));
    }
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
    if (!event.persisted) return;
    closeSheet();
    // A restored page may hold answers changed elsewhere meanwhile: stop sharing and read them again.
    if (!panel.providers.some((item) => item.consent)) return;
    void revalidate();
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
  // A column island may already have published its place while it mounted; each page's context goes out once.
  const swapped = () => {
    collectContext();
    if (pageUnsent) {
      pageUnsent = false;
      if (context && allowed()) sendContext();
      else stopSharing();
    } else if (provider.consent && !allowed()) stopSharing();
    update();
  };
  collectContext();
  window.addEventListener("ssr:nav-swapped", swapped);
  window.addEventListener(PAGE_CONTEXT_CHANGED, collectContext);
  window.addEventListener(COMMANDS_CHANGED, commandsChanged);
  window.addEventListener("cloud.panel.consent", consentRequest);
  window.addEventListener("message", message);
  window.addEventListener("keydown", key);
  slot.addEventListener("click", click);
  phoneChange.addEventListener("change", modeChange);
  column.addEventListener("change", modeChange);
  window.addEventListener("pageshow", pageShow);
  // Restored from the back/forward cache before this lazy module arrived: the server's answers may be outdated.
  if (document.documentElement.hasAttribute("data-cloud-page-restored")) void revalidate();
  window.addEventListener("popstate", closeSheet);
  window.addEventListener("ssr:nav-popstate", closeSheet);
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
  // Mounted only now, after update() wrote the state it starts from; a click before this has nothing to change.
  let disposeMenu = () => {};
  if (menuHost) {
    menuHost.replaceChildren();
    const initial: PanelState = {
      provider: provider.id,
      appName: provider.appName,
      consent: provider.consent,
      allowed: allowed(),
      saving: saving.has(provider.id),
      open: isOpen(),
    };
    disposeMenu = render(
      () =>
        createComponent(LocaleProvider, {
          locale: lang,
          get children() {
            return createComponent(PanelMenu, { initial, locale: lang });
          },
        }),
      menuHost,
    );
  }
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeMenu();
    requests.abort();
    ++loadVersion;
    clearContext();
    clearTimer();
    disposeResize();
    removeFallbackFocus();
    window.removeEventListener("ssr:nav-swapped", swapped);
    window.removeEventListener(PAGE_CONTEXT_CHANGED, collectContext);
    window.removeEventListener(COMMANDS_CHANGED, commandsChanged);
    window.removeEventListener("cloud.panel.consent", consentRequest);
    window.removeEventListener("message", message);
    window.removeEventListener("keydown", key);
    slot.removeEventListener("click", click);
    phoneChange.removeEventListener("change", modeChange);
    column.removeEventListener("change", modeChange);
    window.removeEventListener("pageshow", pageShow);
    window.removeEventListener("popstate", closeSheet);
    window.removeEventListener("ssr:nav-popstate", closeSheet);
    window.navigation?.removeEventListener("currententrychange", entryChange);
    window.removeEventListener("resize", seedWidth);
    installed = undefined;
  };
  installed = { dispose, request };
  return dispose;
}
