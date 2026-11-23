/**
 * Browser notification utilities for requesting permissions and displaying native notifications.
 *
 * Uses the Notification API, which requires a secure context (HTTPS or localhost).
 * Notifications are suppressed silently in unsupported environments (SSR, denied permission).
 */

// ─── Types ──────────────────────────────────────────────────────────────────────

export type NotificationPermissionState = "granted" | "denied" | "default";

export type ShowNotificationOptions = {
  title: string;
  body: string;
  /** Small icon URL, typically 128x128 px. */
  icon?: string;
  /** Large preview image URL. Supported in Chromium-based browsers only. */
  image?: string;
  /** Tag for deduplication — a new notification with the same tag replaces the previous one. */
  tag?: string;
  /** Auto-close after this many milliseconds. Disabled when omitted. */
  autoCloseMs?: number;
  /** Called when the user clicks the notification. */
  onClick?: () => void;
  /** Called when the notification is closed (manually, via auto-close, or by the OS). */
  onClose?: () => void;
};

export type NotificationHandle = {
  /** Programmatically close the notification. Safe to call more than once. */
  close: () => void;
};

// ─── Internals ──────────────────────────────────────────────────────────────────

const hasNotificationAPI = (): boolean =>
  typeof window !== "undefined" && typeof Notification !== "undefined";

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Check whether the Notification API is available in the current environment.
 *
 * Returns `false` during SSR, in Web Workers, or in browsers that do not
 * implement the Notification API.
 */
export const isSupported = (): boolean => hasNotificationAPI();

/**
 * Get the current notification permission state without prompting the user.
 *
 * Returns `"default"` if the user has not yet been asked, `"granted"` if
 * allowed, or `"denied"` if blocked. Falls back to `"denied"` in
 * environments where the Notification API is unavailable.
 */
export const getPermission = (): NotificationPermissionState => {
  if (!hasNotificationAPI()) return "denied";
  return Notification.permission as NotificationPermissionState;
};

/**
 * Request notification permission from the user.
 *
 * Triggers the browser's native permission dialog. Returns `true` if the user
 * grants permission, `false` otherwise. No-op (returns `false`) in non-browser
 * environments or if permission was already denied.
 *
 * Side effects: may display a browser-level permission prompt.
 *
 * @example
 * const allowed = await requestPermission();
 * if (allowed) notifications.show({ title: "Hello", body: "It works!" });
 */
export const requestPermission = async (): Promise<boolean> => {
  if (!hasNotificationAPI()) return false;
  try {
    const result = await Notification.requestPermission();
    return result === "granted";
  } catch {
    // Restricted contexts (e.g. cross-origin iframes, sandboxed environments)
    // can throw or reject. Per the documented contract we surface that as
    // "permission denied" rather than letting the rejection escape.
    return false;
  }
};

/**
 * Display a native browser notification.
 *
 * Returns a handle with a `close()` method, or `null` if notifications are
 * unsupported or permission has not been granted. The caller does not need
 * to request permission first — the function checks automatically.
 *
 * Side effects: creates a native OS notification. If `autoCloseMs` is set,
 * a `setTimeout` is registered to auto-dismiss the notification.
 *
 * @example
 * const handle = notifications.show({
 *   title: "New message",
 *   body: "Alice: Hey, are you there?",
 *   icon: "/avatar.png",
 *   tag: "chat-42",
 *   autoCloseMs: 5000,
 *   onClick: () => window.location.assign("/chat/42"),
 * });
 *
 * // Close programmatically if needed
 * handle?.close();
 */
export const show = (options: ShowNotificationOptions): NotificationHandle | null => {
  if (!hasNotificationAPI() || Notification.permission !== "granted") return null;

  let notification: Notification;
  try {
    notification = new Notification(options.title, {
      body: options.body,
      icon: options.icon,
      image: options.image,
      tag: options.tag,
    } as NotificationOptions);
  } catch {
    // Notification constructor can throw in certain restricted contexts
    return null;
  }

  let timerId: ReturnType<typeof setTimeout> | null = null;

  const close = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    notification.close();
  };

  if (options.onClick) {
    const onClick = options.onClick;
    notification.onclick = () => {
      window.focus();
      notification.close();
      onClick();
    };
  }

  if (options.onClose) {
    notification.onclose = options.onClose;
  }

  if (options.autoCloseMs !== undefined && options.autoCloseMs > 0) {
    timerId = setTimeout(() => {
      timerId = null;
      notification.close();
    }, options.autoCloseMs);
  }

  return { close };
};

// ─── Namespace Export ────────────────────────────────────────────────────────────

/** Browser notification utilities for permission management and native notifications. */
export const notifications = {
  isSupported,
  getPermission,
  requestPermission,
  show,
} as const;
