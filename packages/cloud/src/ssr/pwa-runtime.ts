import { hasAppActions } from "../browser/app-actions";
import { renewAppSession } from "../browser/app-session";
import { pwaDrafts } from "../browser/pwa-drafts";
import { reloadOnce } from "../browser/reload";
import { rememberedPwaAddress } from "../contracts/pwa-location";
import { PWA_SCOPE, PWA_SERVICE_WORKER_PATH } from "../contracts/pwa-paths";

/** Set once per browsing session, so the first page renews and later navigations do not. */
const RENEWED_MARKER = "cloud.pwa.renewed";
const KEEPALIVE_INTERVAL_MS = 60 * 60 * 1000;
/** Fires for preference changes and system scheme changes from the head script. */
export const THEME_PREFERENCE_EVENT = "cloud:theme-preference";

export type PwaRuntimeProps = {
  /** A person uses the app: keep the app session alive. */
  keepalive: boolean;
  /** The installation name, for the account notice. */
  cloud: string;
  accountId?: string;
  /** Builds used by this document: its owner and Core shared assets. */
  builds?: Record<string, string>;
  /** Only successful authenticated documents remember browser-history navigation. */
  rememberAddress?: { cookie: string; maxAge: number };
};

/**
 * How a frame tells the person what the runtime found: the v1 frame with toasts, the v2 frame with notices. Each is
 * called at most once per state; the runtime's cleanup calls `offline(false)` and `clear()`.
 */
export type PwaRuntimeView = {
  /** The phone went offline (`true`) or came back (`false`). */
  offline: (offline: boolean) => void;
  /** Chrome on the phone is signed in to another account than the app; shown once per page. */
  otherAccount: (name: string) => void;
  /** A newer build is out and the page could not reload by itself; offers a reload. */
  newVersion: () => void;
  /** The page leaves: take away what is still shown. */
  clear: () => void;
};

const firstPageOfSession = (): boolean => {
  try {
    if (window.sessionStorage.getItem(RENEWED_MARKER)) return false;
    window.sessionStorage.setItem(RENEWED_MARKER, "1");
  } catch {}
  return true;
};

/**
 * The browser side of every mobile app page, shared by the v1 and the v2 frame: the service worker, the offline
 * state, the app session keepalive, the remembered address and the update check. Returns the cleanup.
 */
export function startPwaRuntime(props: PwaRuntimeProps, view: PwaRuntimeView): () => void {
  const cleanups: (() => void)[] = [() => view.clear()];
  const stop = () => {
    for (const cleanup of cleanups) cleanup();
  };

  // The launch bounce marks its return; the page is here now, so the marker leaves the address.
  const url = new URL(location.href);
  if (url.searchParams.has("pwa_launch")) {
    url.searchParams.delete("pwa_launch");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  }

  // Registration fails in private windows and insecure contexts; the app then simply works online only.
  void navigator.serviceWorker?.register(PWA_SERVICE_WORKER_PATH, { scope: PWA_SCOPE, updateViaCache: "none" }).catch(() => undefined);

  let isOffline = false;
  const offline = () => {
    if (isOffline) return;
    isOffline = true;
    view.offline(true);
  };
  const online = () => {
    if (!isOffline) return;
    isOffline = false;
    view.offline(false);
  };
  if (!navigator.onLine) offline();
  window.addEventListener("offline", offline);
  window.addEventListener("online", online);
  cleanups.push(() => {
    window.removeEventListener("offline", offline);
    window.removeEventListener("online", online);
    online();
  });

  if (!props.keepalive) return stop;

  if (props.rememberAddress) {
    const { cookie, maxAge } = props.rememberAddress;
    const remember = () => {
      const address = rememberedPwaAddress(location.pathname + location.search);
      if (address) document.cookie = `${cookie}=${encodeURIComponent(address)}; Path=${PWA_SCOPE}; Secure; SameSite=Lax; Max-Age=${maxAge}`;
    };
    // The place counts when a page arrives and when the app leaves the foreground, the moment the system may end
    // it. Selections that parts keep in the address without a page load, such as a Spaces task, are covered this
    // way too. A document that is being left writes nothing: the next page, or a sign-out that deleted the
    // cookie, has already answered, and the outgoing page fires "pagehide" before it turns hidden.
    let leaving = false;
    const hidden = () => {
      if (document.visibilityState === "hidden" && !leaving) remember();
    };
    const leave = () => {
      leaving = true;
    };
    const back = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      leaving = false;
      remember();
    };
    remember();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", back);
    cleanups.push(() => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", back);
    });
  }

  let otherAccountShown = false;
  let disposed = false;
  cleanups.push(() => {
    disposed = true;
  });
  let updateShown = false;
  let reloading = false;
  // Every control a person types into, numbers, dates and times included.
  const textField =
    'textarea, input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"], [type="hidden"], [type="file"], [type="range"], [type="color"], [type="image"]), [contenteditable]:not([contenteditable="false"])';
  const edited = new WeakSet<Element>();
  const input = (event: Event) => {
    const field = event.target instanceof Element ? event.target.closest(textField) : null;
    if (field) edited.add(field);
  };
  document.addEventListener("input", input, true);
  cleanups.push(() => document.removeEventListener("input", input, true));
  const unsafe = () =>
    hasAppActions() ||
    document.activeElement?.matches(textField) ||
    !!(props.accountId && pwaDrafts.has(props.accountId)) ||
    !!document.querySelector('dialog[open]:not([aria-modal="false"])') ||
    [...document.querySelectorAll(textField)].some(
      (field) =>
        edited.has(field) &&
        (!(field instanceof window.HTMLInputElement || field instanceof window.HTMLTextAreaElement) || field.value !== field.defaultValue),
    );
  const renew = async (foreground = false) => {
    const { ok, otherAccount, builds } = await renewAppSession();
    if (disposed) return;
    if (otherAccount && !otherAccountShown) {
      otherAccountShown = true;
      view.otherAccount(otherAccount.name);
    }
    const changed = ok && Object.entries(props.builds ?? {}).some(([id, build]) => builds?.[id] !== undefined && builds[id] !== build);
    if (!changed || reloading || document.visibilityState !== "visible") return;
    // Only the foreground transition is an automatic reload opportunity. Re-check input after the request.
    if (foreground && !unsafe() && reloadOnce("pwa-update")) {
      reloading = true;
      return;
    }
    if (updateShown) return;
    updateShown = true;
    view.newVersion();
  };

  if (firstPageOfSession()) void renew();
  const visible = () => {
    if (document.visibilityState === "visible") void renew(true);
  };
  document.addEventListener("visibilitychange", visible);
  // runtime-timer: the installed app's session keepalive in the browser, for as long as the page lives; cleared with it
  const timer = setInterval(() => {
    if (document.visibilityState === "visible") void renew();
  }, KEEPALIVE_INTERVAL_MS);
  cleanups.push(() => {
    document.removeEventListener("visibilitychange", visible);
    clearInterval(timer);
  });
  return stop;
}
