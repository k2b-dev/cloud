import { notifications as nativeNotifications } from "@k2b/stdlib/browser";
import { apiClient } from "../clients/core";
import type { BrowserPushSubscription } from "../contracts";
import { withNotificationTimeout } from "./notification-timeout";

const SERVICE_WORKER_PATH = "/service-worker.js";
const SERVICE_WORKER_SCOPE = "/";
const STATE_CHECK_TIMEOUT_MS = 5_000;

export type BrowserNotificationState = {
  supported: boolean;
  permission: NotificationPermission;
  enabled: boolean;
  reason?: string;
};

const isIos = (): boolean =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const isStandalone = (): boolean =>
  window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

const support = (): { supported: boolean; reason?: string } => {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !nativeNotifications.isSupported()
  ) {
    return { supported: false, reason: "Browser notifications are not supported in this browser." };
  }
  if (isIos() && !isStandalone()) {
    return {
      supported: false,
      reason: "On iPhone and iPad, add Cloud to your Home Screen before enabling browser notifications.",
    };
  }
  return { supported: true };
};

const ensureServiceWorker = (): Promise<ServiceWorkerRegistration> =>
  navigator.serviceWorker.register(SERVICE_WORKER_PATH, { scope: SERVICE_WORKER_SCOPE });

const subscriptionPayload = (subscription: PushSubscription): BrowserPushSubscription => {
  const serialized = subscription.toJSON();
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!serialized.endpoint || !p256dh || !auth) {
    throw new Error("The browser returned an incomplete push subscription.");
  }
  return {
    endpoint: serialized.endpoint,
    expirationTime: subscription.expirationTime,
    keys: { p256dh, auth },
  };
};

const responseError = async (response: Pick<Response, "json">, fallback: string): Promise<Error> => {
  try {
    const payload = (await response.json()) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim()) return new Error(payload.message);
  } catch {
    // The endpoint may return an empty or non-JSON infrastructure error.
  }
  return new Error(fallback);
};

const registerEndpoint = async (subscription: PushSubscription): Promise<void> => {
  const response = await apiClient.me.notifications.browser.endpoints.$post({
    json: {
      subscription: subscriptionPayload(subscription),
      label: navigator.platform ? `Browser on ${navigator.platform}` : "This browser",
    },
  });
  if (!response.ok) throw await responseError(response, "Failed to register this browser for notifications.");
};

const decodeApplicationServerKey = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = window.atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const pushSubscriptionError = (cause: unknown): Error => {
  const name = cause instanceof DOMException ? cause.name : "";
  const message = cause instanceof Error ? cause.message.toLowerCase() : "";
  if (name === "NotAllowedError" || message.includes("permission") || message.includes("incognito")) {
    return new Error("This browser refused push registration. Check its notification permissions or private browsing mode.");
  }
  if (name === "AbortError") return new Error("Push registration was interrupted. Try again.");
  return new Error("This browser could not create a push subscription.");
};

const currentState = async (registration?: ServiceWorkerRegistration): Promise<BrowserNotificationState> => {
  const capability = support();
  if (!capability.supported) {
    return { supported: false, permission: "denied", enabled: false, reason: capability.reason };
  }
  return withNotificationTimeout(
    (async () => {
      const activeRegistration = registration ?? (await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE));
      const subscription = await activeRegistration?.pushManager.getSubscription();
      return {
        supported: true,
        permission: Notification.permission,
        enabled: Notification.permission === "granted" && !!subscription,
      };
    })(),
    STATE_CHECK_TIMEOUT_MS,
    "Browser notification status check timed out.",
  );
};

export const browserNotificationClient = {
  state: currentState,

  /** Register the worker and rebind an existing subscription to the signed-in user. Never prompts. */
  refreshExisting: async (): Promise<BrowserNotificationState> => {
    const capability = support();
    if (!capability.supported) return currentState();
    const registration = await ensureServiceWorker();
    if (Notification.permission !== "granted") return currentState(registration);
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) await registerEndpoint(subscription);
    return currentState(registration);
  },

  /** Must only be called from an explicit user action because it may show a permission prompt. */
  enable: async (): Promise<BrowserNotificationState> => {
    const capability = support();
    if (!capability.supported) return currentState();
    if (Notification.permission !== "granted" && !(await nativeNotifications.requestPermission())) return currentState();

    const registration = await ensureServiceWorker();
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      const configResponse = await apiClient.me.notifications.browser.configuration.$get();
      if (!configResponse.ok) {
        throw await responseError(configResponse, "Failed to load browser notification configuration.");
      }
      const config = await configResponse.json();
      try {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeApplicationServerKey(config.publicKey),
        });
      } catch (cause) {
        throw pushSubscriptionError(cause);
      }
    }
    await registerEndpoint(subscription);
    return currentState(registration);
  },

  disable: async (): Promise<BrowserNotificationState> => {
    const capability = support();
    if (!capability.supported) return currentState();
    const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_SCOPE);
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      let endpointError: Error | null = null;
      try {
        const response = await apiClient.me.notifications.browser.endpoints.$delete({
          json: { subscription: subscriptionPayload(subscription) },
        });
        if (!response.ok) endpointError = await responseError(response, "Failed to disable browser notifications.");
      } catch (cause) {
        endpointError = cause instanceof Error ? cause : new Error("Failed to disable browser notifications.");
      }
      await subscription.unsubscribe();
      if (endpointError) throw endpointError;
    }
    return currentState(registration);
  },
} as const;
