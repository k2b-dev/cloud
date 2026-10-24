import { observeMobileShell, syncThemeColor, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { renewAppSession } from "../browser/app-session";
import { pwaDrafts } from "../browser/pwa-drafts";
import { reloadOnce } from "../browser/reload";
import { rememberedPwaAddress } from "../contracts/pwa-location";
import { PWA_SCOPE, PWA_SERVICE_WORKER_PATH } from "../contracts/pwa-paths";
import { pwaMessages } from "./pwa-messages";

/** Set once per browsing session, so the first page renews and later navigations do not. */
const RENEWED_MARKER = "cloud.pwa.renewed";
const KEEPALIVE_INTERVAL_MS = 60 * 60 * 1000;
/** Fires for preference changes and system scheme changes from the head script. */
const THEME_PREFERENCE_EVENT = "cloud:theme-preference";

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

const firstPageOfSession = (): boolean => {
  try {
    if (window.sessionStorage.getItem(RENEWED_MARKER)) return false;
    window.sessionStorage.setItem(RENEWED_MARKER, "1");
  } catch {}
  return true;
};

/**
 * The browser side of every mobile app page: the service worker, the offline notice, the app session keepalive,
 * the status bar colour after a theme change, and the server-rendered shell's measurements.
 */
export default function PwaRuntime(props: PwaRuntimeProps) {
  const locale = useLocale();
  const t = () => pwaMessages.resolve([locale()]).t;

  onMount(() => {
    const cleanups: (() => void)[] = [];
    onCleanup(() => {
      for (const cleanup of cleanups) cleanup();
    });

    const shell = document.querySelector<HTMLElement>(".k2b-mobile-shell");
    if (shell) cleanups.push(observeMobileShell(shell));

    // The launch bounce marks its return; the page is here now, so the marker leaves the address.
    const url = new URL(location.href);
    if (url.searchParams.has("pwa_launch")) {
      url.searchParams.delete("pwa_launch");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }

    // Registration fails in private windows and insecure contexts; the app then simply works online only.
    void navigator.serviceWorker?.register(PWA_SERVICE_WORKER_PATH, { scope: PWA_SCOPE, updateViaCache: "none" }).catch(() => undefined);

    let offlineToast: ToastHandle | undefined;
    const offline = () => {
      offlineToast ??= toast(t().offline, { duration: 0, iconClass: "ti ti-wifi-off" });
    };
    const online = () => {
      offlineToast?.dismiss();
      offlineToast = undefined;
    };
    if (!navigator.onLine) offline();
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    cleanups.push(() => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      offlineToast?.dismiss();
    });

    const syncTheme = () => syncThemeColor();
    window.addEventListener(THEME_PREFERENCE_EVENT, syncTheme);
    cleanups.push(() => window.removeEventListener(THEME_PREFERENCE_EVENT, syncTheme));

    if (!props.keepalive) return;

    if (props.rememberAddress) {
      const { cookie, maxAge } = props.rememberAddress;
      const remember = () => {
        const address = rememberedPwaAddress(location.pathname + location.search);
        if (address)
          document.cookie = `${cookie}=${encodeURIComponent(address)}; Path=${PWA_SCOPE}; Secure; SameSite=Lax; Max-Age=${maxAge}`;
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
    let updateToast: ToastHandle | undefined;
    let reloading = false;
    cleanups.push(() => updateToast?.dismiss());
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
      document.activeElement?.matches(textField) ||
      !!(props.accountId && pwaDrafts.has(props.accountId)) ||
      !!document.querySelector('dialog[open]:not([aria-modal="false"])') ||
      [...document.querySelectorAll(textField)].some(
        (field) =>
          edited.has(field) &&
          (!(field instanceof window.HTMLInputElement || field instanceof window.HTMLTextAreaElement) ||
            field.value !== field.defaultValue),
      );
    const renew = async (foreground = false) => {
      const { ok, otherAccount, builds } = await renewAppSession();
      if (disposed) return;
      if (otherAccount && !otherAccountShown) {
        otherAccountShown = true;
        toast(t().otherAccount({ cloud: props.cloud, name: otherAccount.name }), { duration: 0, iconClass: "ti ti-alert-triangle" });
      }
      const changed = ok && Object.entries(props.builds ?? {}).some(([id, build]) => builds?.[id] !== undefined && builds[id] !== build);
      if (!changed || reloading || document.visibilityState !== "visible") return;
      // Only the foreground transition is an automatic reload opportunity. Re-check input after the request.
      if (foreground && !unsafe() && reloadOnce("pwa-update")) {
        reloading = true;
        return;
      }
      updateToast ??= toast(t().newVersion, { duration: 0, action: { label: t().reload, onClick: () => location.reload() } });
    };

    if (firstPageOfSession()) void renew();
    const visible = () => {
      if (document.visibilityState === "visible") void renew(true);
    };
    document.addEventListener("visibilitychange", visible);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void renew();
    }, KEEPALIVE_INTERVAL_MS);
    cleanups.push(() => {
      document.removeEventListener("visibilitychange", visible);
      clearInterval(timer);
    });
  });

  return null;
}
