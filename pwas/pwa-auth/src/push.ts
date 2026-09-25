import { localStore } from "@k2b/stdlib/solid";
import { createSignal, onCleanup, onMount } from "solid-js";
import type { Installation } from "./install";
import { PREFERENCES_CACHE } from "./push-worker";

/**
 * - `unsupported`: this browser or this Cloud Login server offers no push.
 * - `not-installed`: iPhone and iPad allow push only for Home Screen apps (iOS 16.4+).
 * - `default`: not asked yet; asking needs a tap.
 * - `denied`: blocked; only the browser or system settings can undo that.
 * - `inactive`: allowed, but this device is not registered for push yet.
 * - `active`: allowed and registered.
 */
export type PushState = "checking" | "unsupported" | "not-installed" | "default" | "denied" | "inactive" | "active";

type Stored = { endpoint?: string; token?: string; dismissed?: boolean };
type SubscriptionLike = { endpoint: string; toJSON(): unknown; unsubscribe(): Promise<boolean> };
type RegistrationLike = {
  pushManager: {
    getSubscription(): Promise<SubscriptionLike | null>;
    subscribe(options: PushSubscriptionOptionsInit): Promise<SubscriptionLike>;
  };
};
type Browser = {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  permission: () => NotificationPermission | undefined;
  requestPermission: () => Promise<NotificationPermission>;
  registration: () => Promise<RegistrationLike | undefined>;
};

const decodeKey = (value: string) => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

/** The service worker renders notifications in the language the app uses. */
export const rememberLocale = (locale: string) => {
  if (typeof caches === "undefined") return;
  void caches
    .open(PREFERENCES_CACHE)
    .then((cache) => cache.put("/locale", new Response(locale)))
    .catch(() => {});
};

export const browserSupportsPush = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

const defaultBrowser = (): Browser => ({
  fetch: (path, init) => fetch(path, { ...init, credentials: "omit", signal: AbortSignal.timeout(15_000) }),
  permission: () => (browserSupportsPush() ? Notification.permission : undefined),
  requestPermission: () => Notification.requestPermission(),
  registration: async () => (browserSupportsPush() ? await navigator.serviceWorker.getRegistration() : undefined),
});

/** Push is only a wake-up for pending sign-ins. Every failure leaves the app working as before. */
export function createPush(installation: Installation, browser: Browser = defaultBrowser()) {
  const [stored, setStored] = localStore.create<Stored>("pwa-auth.push", {});
  const [publicKey, setPublicKey] = createSignal<string | null>();
  const [permission, setPermission] = createSignal(browser.permission());
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const state = (): PushState => {
    if (installation.platform === "apple-mobile" && !installation.installed() && permission() === undefined) return "not-installed";
    if (permission() === undefined || publicKey() === null) return "unsupported";
    if (publicKey() === undefined) return "checking";
    if (permission() === "denied") return "denied";
    if (permission() === "default") return "default";
    return stored.token ? "active" : "inactive";
  };

  const loadConfig = async () => {
    try {
      const response = await browser.fetch("/push/config");
      if (response.status === 404) return setPublicKey(null);
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "publicKey" in body && typeof body.publicKey === "string") setPublicKey(body.publicKey);
    } catch {
      // Offline: keep checking state; the app still works without push.
    }
  };

  const register = async (): Promise<boolean> => {
    const key = publicKey();
    const registration = await browser.registration();
    if (!key || !registration) return false;
    const options = { userVisibleOnly: true, applicationServerKey: decodeKey(key) };
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && subscription.endpoint === stored.endpoint && stored.token) return true;
    try {
      subscription ??= await registration.pushManager.subscribe(options);
    } catch {
      // A subscription for an older server key blocks a new one.
      await (await registration.pushManager.getSubscription())?.unsubscribe();
      subscription = await registration.pushManager.subscribe(options);
    }
    const response = await browser.fetch("/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string") return false;
    setStored({ endpoint: subscription.endpoint, token: body.token });
    return true;
  };

  const run = async (operation: () => Promise<boolean>) => {
    if (busy()) return false;
    setBusy(true);
    setFailed(false);
    try {
      const ok = await operation();
      setFailed(!ok);
      return ok;
    } catch {
      setFailed(true);
      return false;
    } finally {
      setPermission(browser.permission());
      setBusy(false);
    }
  };

  const refresh = () => {
    setPermission(browser.permission());
    if (permission() === "granted" && publicKey()) void run(register);
  };

  onMount(() => {
    if (permission() === undefined) return;
    void loadConfig().then(refresh);
    document.addEventListener("visibilitychange", refresh);
    onCleanup(() => document.removeEventListener("visibilitychange", refresh));
  });

  return {
    state,
    busy,
    failed,
    token: () => stored.token,
    dismissed: () => stored.dismissed === true,
    dismiss: () => setStored("dismissed", true),
    /** Call directly from a tap: iOS only shows the permission prompt for a user gesture. */
    enable: () =>
      run(async () => {
        const result = await browser.requestPermission();
        setPermission(result);
        return result === "granted" ? register() : true;
      }),
    retry: () => run(register),
    /** Sends a notification through the whole chain: server, push service and service worker. */
    test: () =>
      run(async () => {
        const send = () =>
          browser.fetch("/push/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: stored.token }),
          });
        let response = await send();
        if (response.status === 410) {
          setStored("token", undefined);
          if (!(await register())) return false;
          response = await send();
        }
        return response.status === 202;
      }),
  };
}
export type Push = ReturnType<typeof createPush>;
