import { authMessages } from "./i18n";

/**
 * Service-worker push handlers, bundled into `sw.js` by `scripts/service-worker.ts`.
 * A push only wakes the phone: the app still loads every request through the
 * signed Cloud channel. The payload is never trusted for anything but display.
 */
export const PREFERENCES_CACHE = "cloud-login-preferences";
export const OPEN_REQUEST_MESSAGE = "cloud-login-open-request";

type Message = { type: "login"; cloud: string; ref: string } | { type: "test" } | { type: "unknown" };
type WindowLike = { url: string; focus(): Promise<unknown>; postMessage(message: unknown): void };
type Waitable = { waitUntil(promise: Promise<unknown>): void };
type PushEventLike = Waitable & { data?: { text(): string } | null };
type ClickEventLike = Waitable & { notification: { close(): void; data?: unknown } };
export type PushScope = {
  location: { origin: string };
  registration: { showNotification(title: string, options: NotificationOptions): Promise<void> };
  clients: {
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<readonly WindowLike[]>;
    openWindow(url: string): Promise<unknown>;
  };
  caches?: { open(name: string): Promise<{ match(path: string): Promise<Response | undefined> }> };
  languages: readonly string[];
  onPush(listener: (event: PushEventLike) => void): void;
  onClick(listener: (event: ClickEventLike) => void): void;
};

export const parsePushMessage = (text: string | undefined): Message => {
  try {
    const value: unknown = JSON.parse(text ?? "");
    if (!value || typeof value !== "object" || !("v" in value) || value.v !== 1 || !("type" in value)) return { type: "unknown" };
    if (value.type === "test") return { type: "test" };
    if (
      value.type === "login" &&
      "cloud" in value &&
      typeof value.cloud === "string" &&
      "ref" in value &&
      typeof value.ref === "string" &&
      /^[A-Za-z0-9_-]{1,64}$/.test(value.ref)
    ) {
      const url = new URL(value.cloud);
      if (url.origin === value.cloud) return { type: "login", cloud: value.cloud, ref: value.ref };
    }
  } catch {
    // Fall through: iOS removes the subscription if a push shows nothing.
  }
  return { type: "unknown" };
};

export const notificationFor = (message: Message, languages: readonly string[]) => {
  const { locale, t } = authMessages.resolve(languages);
  const base = { icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", lang: locale };
  if (message.type === "login")
    return {
      title: t.pushLoginTitle({ cloud: new URL(message.cloud).host }),
      options: { ...base, body: t.pushLoginBody, tag: `login:${message.cloud}`, data: { url: `/?request=${message.ref}` } },
    };
  if (message.type === "test") return { title: t.appName, options: { ...base, body: t.pushTestBody, tag: "test", data: { url: "/" } } };
  return { title: t.appName, options: { ...base, body: t.pushGenericBody, tag: "login", data: { url: "/" } } };
};

export function installPushHandlers(scope: PushScope) {
  const languages = async () => {
    try {
      const saved = await (await (await scope.caches?.open(PREFERENCES_CACHE))?.match("/locale"))?.text();
      return saved ? [saved, ...scope.languages] : scope.languages;
    } catch {
      return scope.languages;
    }
  };
  scope.onPush((event) => {
    event.waitUntil(
      (async () => {
        const { title, options } = notificationFor(parsePushMessage(event.data?.text()), await languages());
        await scope.registration.showNotification(title, options);
      })(),
    );
  });
  scope.onClick((event) => {
    event.notification.close();
    event.waitUntil(
      (async () => {
        const data = event.notification.data;
        const path = data && typeof data === "object" && "url" in data && typeof data.url === "string" ? data.url : "/";
        const target = new URL(path, scope.location.origin);
        const url = target.origin === scope.location.origin ? target.href : `${scope.location.origin}/`;
        const ref = new URL(url).searchParams.get("request");
        const windows = await scope.clients.matchAll({ type: "window", includeUncontrolled: true });
        const open = windows.find((client) => new URL(client.url).origin === scope.location.origin);
        if (!open) return scope.clients.openWindow(url);
        if (ref) open.postMessage({ type: OPEN_REQUEST_MESSAGE, ref });
        return open.focus();
      })(),
    );
  });
}

type WorkerGlobal = Omit<PushScope, "languages" | "onPush" | "onClick"> & {
  navigator: { languages: readonly string[] };
  addEventListener(type: "push" | "notificationclick", listener: (event: never) => void): void;
};
const isWorker = (value: unknown): value is WorkerGlobal =>
  typeof window === "undefined" && typeof value === "object" && value !== null && "registration" in value && "clients" in value;
const worker: unknown = globalThis;
if (isWorker(worker)) {
  installPushHandlers({
    location: worker.location,
    registration: worker.registration,
    clients: worker.clients,
    caches: worker.caches,
    languages: worker.navigator.languages,
    onPush: (listener) => worker.addEventListener("push", listener),
    onClick: (listener) => worker.addEventListener("notificationclick", listener),
  });
}
