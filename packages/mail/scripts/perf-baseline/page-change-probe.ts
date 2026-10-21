import type { z } from "zod";
import type { panelEndState } from "../../../../scripts/perf-baseline/panel-probe";
import type { resourceCountsSchema } from "./page-change-model";

type Counts = z.infer<typeof resourceCountsSchema>;
type Watch = {
  targetPath: string;
  mainSelector: string;
  mainText: string | null;
  actionSelector: string;
  responseSelector: string | null;
  expectedHelpTopic: string | null;
  actionAt: number | null;
  mainAt: number | null;
  readyAt: number | null;
  firstActionAt: number | null;
  panelAt: number | null;
  trustedInput: boolean;
};
declare global {
  interface Window {
    __mailPageChange: {
      arm: (watch: Omit<Watch, "actionAt" | "mainAt" | "readyAt" | "firstActionAt" | "panelAt" | "trustedInput">) => void;
      read: () => Watch | null;
      errors: () => string[];
      stop: () => void;
      eagerScripts: () => string[];
      panelReady: (mailbox: boolean) => boolean;
    };
    __mailResources: () => Counts;
  }
}
export const pageChangeKey = "cloud-mail-page-change";

/** Stored epoch times survive real document loads; the same probe also observes swaps. */
export function installPageChangeProbe({ key, panel }: { key: string; panel: typeof panelEndState }) {
  if (window !== window.top) return;
  const errorKey = `${key}:errors`;
  const errors = (): string[] => JSON.parse(sessionStorage.getItem(errorKey) ?? "[]");
  window.addEventListener("unhandledrejection", (event) => {
    sessionStorage.setItem(errorKey, JSON.stringify([...errors(), String(event.reason)]));
  });
  document.addEventListener("ssr:island-error", () => {
    sessionStorage.setItem(errorKey, JSON.stringify([...errors(), "ssr:island-error during page change"]));
  });
  const now = () => performance.timeOrigin + performance.now();
  const read = (): Watch | null => JSON.parse(sessionStorage.getItem(key) ?? "null");
  const write = (watch: Watch) => sessionStorage.setItem(key, JSON.stringify(watch));
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < innerHeight &&
      rect.left < innerWidth &&
      style.visibility === "visible" &&
      style.display !== "none"
    );
  };
  let frame: number | undefined;
  let eagerAtReady: string[] | undefined;
  const stop = () => {
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    eagerAtReady = undefined;
  };
  const tick = () => {
    frame = undefined;
    const watch = read();
    if (!watch) return;
    if (watch.actionAt !== null && location.pathname === watch.targetPath) {
      const main = [...document.querySelectorAll(watch.mainSelector)].find(
        (el) => visible(el) && (!watch.mainText || el.textContent?.includes(watch.mainText)),
      );
      if (main && watch.mainAt === null) watch.mainAt = now();
      const action = [...document.querySelectorAll(watch.actionSelector)].find(visible);
      const island = action?.closest("solid-island,solid-client");
      if (
        main &&
        action &&
        !action.matches(":disabled,[aria-disabled=true]") &&
        island &&
        window.__cloudPerf.mounted.has(island) &&
        watch.readyAt === null
      ) {
        watch.readyAt = now();
        // Later dynamic imports can add modulepreloads after this measurement window.
        eagerAtReady = window.__mailPageChange.eagerScripts();
      }
      if (watch.trustedInput && watch.firstActionAt === null) {
        const response = watch.responseSelector ? document.querySelector(watch.responseSelector) : null;
        if (response && visible(response)) watch.firstActionAt = now();
      }
      if (watch.panelAt === null && panel("navigation", watch.expectedHelpTopic ? "view" : "start").holds) {
        const doc = document.querySelector<HTMLIFrameElement>('#cloud-panel iframe[data-cloud-panel-frame="core"]')?.contentDocument;
        if (
          doc &&
          (watch.expectedHelpTopic
            ? doc.querySelector(`[data-help-view] [data-help-topic="${watch.expectedHelpTopic}"]`)
            : !doc.querySelector("[data-help-view]"))
        )
          watch.panelAt = now();
      }
      write(watch);
    }
    if (watch.firstActionAt === null || (innerWidth >= 1024 && watch.panelAt === null)) frame = requestAnimationFrame(tick);
  };
  const panelReady = (mailbox: boolean) => {
    if (!panel("navigation", mailbox ? "view" : "start").holds) return false;
    const doc = document.querySelector<HTMLIFrameElement>('#cloud-panel iframe[data-cloud-panel-frame="core"]')?.contentDocument;
    return (
      !!doc && (mailbox ? !!doc.querySelector('[data-help-view] [data-help-topic="mail-work"]') : !doc.querySelector("[data-help-view]"))
    );
  };
  window.__mailPageChange = {
    read,
    errors,
    stop,
    panelReady,
    eagerScripts: () => {
      if (eagerAtReady) return eagerAtReady;
      const urls = new Set(
        [...document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('script[src],link[rel="modulepreload"]')].map((element) =>
          element instanceof HTMLScriptElement ? element.src : element.href,
        ),
      );
      // Island entries are imported by the inline loader, so script[src] alone misses them.
      for (const loader of document.querySelectorAll<HTMLScriptElement>("script[data-ssr-assets]")) {
        const base = loader.dataset.ssrAssets!;
        for (const element of document.querySelectorAll<HTMLElement>("solid-island[data-id],solid-client[data-id]"))
          urls.add(new URL(`${base}/${element.dataset.id}.js`, document.baseURI).href);
        for (const file of loader.dataset.ssrPreload?.split(" ").filter(Boolean) ?? [])
          urls.add(new URL(`${base}/${file}`, document.baseURI).href);
      }
      return [...urls].filter((url) => /\.m?js(?:\?|$)/.test(url));
    },
    arm: (watch) => {
      stop();
      sessionStorage.removeItem(errorKey);
      write({ ...watch, actionAt: null, mainAt: null, readyAt: null, firstActionAt: null, panelAt: null, trustedInput: false });
      frame = requestAnimationFrame(tick);
    },
  };
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isTrusted) return;
      const watch = read();
      if (!watch || watch.actionAt !== null) return;
      watch.actionAt = performance.timeOrigin + event.timeStamp;
      write(watch);
    },
    { capture: true },
  );
  const trusted = (event: Event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const watch = read();
    if (!watch || watch.readyAt === null || !event.target.closest(watch.actionSelector)) return;
    watch.trustedInput = true;
    write(watch);
  };
  document.addEventListener("input", trusted, { capture: true });
  document.addEventListener("click", trusted, { capture: true });
  if (read()) frame = requestAnimationFrame(tick);
}

/** Sequence only: count resources still registered in each live host document. */
export function installResourceProbe() {
  if (window !== window.top) return;
  type Registered = { wrapped: EventListener; forget: () => void };
  const listeners = new Map<EventTarget, Map<string, Map<EventListenerOrEventListenerObject, Registered>>>();
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!listener || (this !== window && this !== document)) return add.call(this, type, listener, options);
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const key = `${type}:${capture}`;
    let target = listeners.get(this);
    if (!target) {
      target = new Map();
      listeners.set(this, target);
    }
    let entries = target.get(key);
    if (!entries) {
      entries = new Map();
      target.set(key, entries);
    }
    if (entries.has(listener)) return;
    if (typeof options === "object" && options.signal?.aborted) return;
    const once = typeof options === "object" && options.once;
    const signal = typeof options === "object" ? options.signal : undefined;
    const forget = () => {
      entries.delete(listener);
      if (signal) remove.call(signal, "abort", forget);
    };
    const wrapped: EventListener = (event) => {
      if (once) forget();
      if (typeof listener === "function") listener.call(this, event);
      else listener.handleEvent(event);
    };
    entries.set(listener, { wrapped, forget });
    if (signal) add.call(signal, "abort", forget, { once: true });
    return add.call(this, type, wrapped, options);
  };
  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const capture = typeof options === "boolean" ? options : !!options?.capture;
    const entries = listeners.get(this)?.get(`${type}:${capture}`);
    const registered = listener ? entries?.get(listener) : undefined;
    registered?.forget();
    return remove.call(this, type, registered?.wrapped ?? listener, options);
  };
  const timeouts = new Set<number>();
  const intervals = new Set<number>();
  const view: Window = window;
  const timeout = view.setTimeout.bind(view);
  const interval = view.setInterval.bind(view);
  const clearTimeout = view.clearTimeout.bind(view);
  const clearInterval = view.clearInterval.bind(view);
  view.setTimeout = (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (typeof handler !== "function") throw new Error("Resource probe cannot observe string timeout handlers");
    const id = timeout(() => {
      timeouts.delete(id);
      handler(...args);
    }, delay);
    timeouts.add(id);
    return id;
  };
  view.setInterval = (handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = interval(handler, delay, ...args);
    intervals.add(id);
    return id;
  };
  view.clearTimeout = (id) => {
    if (id !== undefined) {
      timeouts.delete(id);
      intervals.delete(id);
    }
    clearTimeout(id);
  };
  view.clearInterval = (id) => {
    if (id !== undefined) {
      timeouts.delete(id);
      intervals.delete(id);
    }
    clearInterval(id);
  };
  // Weak references prevent the measuring tool from retaining closed transports.
  let sources: WeakRef<EventSource>[] = [];
  let sockets: WeakRef<WebSocket>[] = [];
  const Source = window.EventSource;
  const Socket = window.WebSocket;
  window.EventSource = class extends Source {
    constructor(url: string | URL, options?: EventSourceInit) {
      super(url, options);
      sources.push(new WeakRef(this));
    }
  };
  window.WebSocket = class extends Socket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(new WeakRef(this));
    }
  };
  const count = (target: EventTarget) => [...(listeners.get(target)?.values() ?? [])].reduce((sum, entries) => sum + entries.size, 0);
  window.__mailResources = () => {
    sources = sources.filter((ref) => {
      const source = ref.deref();
      return source && source.readyState !== Source.CLOSED;
    });
    sockets = sockets.filter((ref) => {
      const socket = ref.deref();
      return socket && socket.readyState !== Socket.CLOSED;
    });
    return {
      windowListeners: count(window),
      documentListeners: count(document),
      timeouts: timeouts.size,
      intervals: intervals.size,
      eventSources: sources.length,
      webSockets: sockets.length,
    };
  };
}
