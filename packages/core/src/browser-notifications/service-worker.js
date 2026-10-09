const PAYLOAD_TYPE = "cloud-notification";
const TARGET_ORIGIN = "https://cloud.invalid";
let badgeUpdates = Promise.resolve();
let notificationUpdates = Promise.resolve();

const safeTargetHref = (value) => {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const target = new URL(value, TARGET_ORIGIN);
    return target.origin === TARGET_ORIGIN && `${target.pathname}${target.search}${target.hash}` === value ? value : null;
  } catch {
    return null;
  }
};

const parsePayload = (event) => {
  if (!event.data) return null;
  try {
    const value = event.data.json();
    if (
      value?.type !== PAYLOAD_TYPE ||
      typeof value.eventId !== "string" ||
      typeof value.title !== "string" ||
      (value.preview !== undefined && typeof value.preview !== "string") ||
      (value.targetHref !== undefined && safeTargetHref(value.targetHref) === null) ||
      (value.group !== undefined && (typeof value.group !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value.group))) ||
      (value.badge !== undefined && (!Number.isSafeInteger(value.badge) || value.badge < 0)) ||
      (value.createdAt !== undefined && (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0))
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
};

const targetHref = (value) => safeTargetHref(value) ?? "/";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const setBadge = async (count) => {
  try {
    if (count === 0) await self.navigator?.clearAppBadge?.();
    else await self.navigator?.setAppBadge?.(count);
  } catch {
    // Badging support and permission must never prevent notification display.
  }
};

const updateBadge = (payload) => {
  badgeUpdates = badgeUpdates.then(async () => {
    if (payload.createdAt !== undefined) {
      try {
        const cache = await self.caches.open("cloud-notification-state");
        const key = new URL("/_cloud/notification-badge", self.location.origin).href;
        const previous = await cache.match(key);
        const createdAt = previous ? Number(await previous.text()) : null;
        if (Number.isSafeInteger(createdAt) && createdAt > payload.createdAt) return;
        await cache.put(key, new Response(String(payload.createdAt)));
      } catch {
        // Cache availability must never prevent badging or notification display.
      }
    }
    await setBadge(payload.badge);
  });
  return badgeUpdates;
};

const showNotification = async (payload) => {
  if (payload.group !== undefined && payload.createdAt !== undefined) {
    let newer;
    try {
      const visible = await self.registration.getNotifications({ tag: payload.group });
      newer = visible.find(
        (notification) => Number.isSafeInteger(notification.data?.createdAt) && notification.data.createdAt > payload.createdAt,
      );
    } catch {
      // Older browsers and lookup failures fall back to normal display.
    }
    if (newer) {
      await self.registration.showNotification(newer.title, {
        icon: newer.icon,
        ...(newer.body ? { body: newer.body } : {}),
        tag: newer.tag,
        data: newer.data,
      });
      return true;
    }
  }
  await self.registration.showNotification(payload.title, {
    icon: "/branding/logo",
    ...(payload.preview !== undefined ? { body: payload.preview } : {}),
    tag: payload.group ?? payload.eventId,
    ...(payload.group !== undefined ? { renotify: true } : {}),
    data: { targetHref: targetHref(payload.targetHref), ...(payload.createdAt !== undefined ? { createdAt: payload.createdAt } : {}) },
  });
  return false;
};

self.addEventListener("push", (event) => {
  const payload = parsePayload(event);
  if (!payload) return;

  // Keep the visible-notification comparison and replacement together across concurrent pushes.
  const display = notificationUpdates.then(() => showNotification(payload));
  notificationUpdates = display.catch(() => {});
  event.waitUntil(
    display.then((stale) => {
      if (!stale && payload.badge !== undefined) return updateBadge(payload);
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = targetHref(event.notification.data?.targetHref);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const exact = windows.find((client) => {
        const url = new URL(client.url);
        return `${url.pathname}${url.search}${url.hash}` === target;
      });
      const existing = exact ?? windows[0];
      if (existing) {
        try {
          const destination = exact ? existing : await existing.navigate(target);
          if (destination) return await destination.focus();
        } catch {
          // A tab can close or stop being controlled while the click is handled.
        }
      }
      return self.clients.openWindow(target);
    })(),
  );
});
