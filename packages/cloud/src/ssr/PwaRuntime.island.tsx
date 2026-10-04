import { observeMobileShell, syncThemeColor, type ToastHandle, toast, useLocale } from "@k2b/ui";
import { onCleanup, onMount } from "solid-js";
import { reloadOnce } from "../browser/reload";
import { PWA_AUTH_PATH, PWA_SCOPE, PWA_SERVICE_WORKER_PATH, PwaRenewResultSchema } from "../contracts/pwa";
import { pwaMessages } from "./pwa-messages";

/** Set once per browsing session, so the first page renews and later navigations do not. */
const RENEWED_MARKER = "cloud.pwa.renewed";
const KEEPALIVE_INTERVAL_MS = 60 * 60 * 1000;
/** Matches `cloud:theme-preference` in the preference controller. */
const THEME_PREFERENCE_EVENT = "cloud:theme-preference";

export type PwaRuntimeProps = {
  /** A person uses the app: keep the app session alive. */
  keepalive: boolean;
  /** The installation name, for the account notice. */
  cloud: string;
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

    let running: Promise<void> | undefined;
    let otherAccountShown = false;
    let disposed = false;
    cleanups.push(() => {
      disposed = true;
    });
    const call = async (): Promise<boolean> => {
      let response: Response;
      try {
        response = await fetch(`${PWA_AUTH_PATH}/session/renew`, {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
      } catch {
        // Offline or unreachable: the next foreground retries.
        return false;
      }
      if (disposed) return false;
      if (response.status === 401) {
        // The page request then renews or leads to pairing.
        reloadOnce("pwa-auth");
        return false;
      }
      if (response.status === 403) {
        const body: unknown = await response.json().catch(() => null);
        if (typeof body === "object" && body !== null && "code" in body && body.code === "ACCOUNT_BLOCKED") {
          location.replace(`${PWA_SCOPE}?pwa=blocked`);
        }
        return false;
      }
      if (!response.ok) return false;
      const parsed = PwaRenewResultSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) return false;
      if (parsed.data.otherAccount && !otherAccountShown) {
        otherAccountShown = true;
        toast(t().otherAccount({ cloud: props.cloud, name: parsed.data.otherAccount.name }), {
          duration: 0,
          iconClass: "ti ti-alert-triangle",
        });
      }
      return parsed.data.renewed;
    };
    const renew = () => {
      // One request at a time. After a rotation, a second call presents the new key and retires the old one.
      running ??= (async () => {
        try {
          if (await call()) await call();
        } finally {
          running = undefined;
        }
      })();
      return running;
    };

    if (firstPageOfSession()) void renew();
    const visible = () => {
      if (document.visibilityState === "visible") void renew();
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
