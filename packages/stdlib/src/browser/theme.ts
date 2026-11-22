/**
 * Light/dark theme toggle with cookie persistence.
 *
 * Manages the `dark` / `light` class on `document.documentElement` and persists
 * the choice to a `theme` cookie so it survives page reloads. Works with any
 * CSS framework that uses a root-level class for dark mode (Tailwind, etc.).
 *
 * SSR-safe: returns `"light"` as default when `document` is unavailable.
 *
 * @example
 * import { theme } from "@k2b/stdlib/browser";
 *
 * theme.getCurrent();  // "light"
 * theme.set("dark");   // applies dark mode, persists to cookie
 * theme.toggle();      // switches back to "light"
 */

import { readCookie, writeCookie } from "./cookies";

export type ThemeMode = "light" | "dark";

/**
 * Read the current theme from the document root element.
 *
 * Returns `"dark"` if `document.documentElement` has the `dark` class,
 * `"light"` otherwise. Returns `"light"` in SSR environments.
 */
const getCurrent = (): ThemeMode => {
  if (typeof document === "undefined") return "light";
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
};

/**
 * Read the persisted theme preference from the `theme` cookie.
 *
 * Returns `"dark"` or `"light"` if the cookie holds a valid value, or
 * `null` if no theme has been persisted yet (caller can fall back to
 * `prefers-color-scheme` / a default in that case).
 *
 * Useful in client-only apps that didn't apply the theme class server-side
 * and need to restore the preference on hydration.
 */
const getPersisted = (): ThemeMode | null => {
  if (typeof document === "undefined") return null;
  const raw = readCookie("theme");
  if (raw === "dark" || raw === "light") return raw;
  return null;
};

/**
 * Apply a theme and persist it to a `theme` cookie.
 *
 * Removes both `dark` and `light` classes from the document root, then adds
 * the requested one. Writes a `theme` cookie with 1-year expiry so the
 * preference is restored on next page load.
 *
 * @param mode - The theme to apply.
 * @returns The applied theme mode.
 */
const set = (mode: ThemeMode): ThemeMode => {
  if (typeof document === "undefined") return mode;
  document.documentElement.classList.remove("dark", "light");
  document.documentElement.classList.add(mode);
  writeCookie("theme", mode);
  return mode;
};

/**
 * Toggle between light and dark mode.
 *
 * Reads the current theme, switches to the opposite, and persists the choice.
 *
 * @returns The new theme mode after toggling.
 */
const toggle = (): ThemeMode => {
  const next = getCurrent() === "dark" ? "light" : "dark";
  return set(next);
};

export const theme = {
  getCurrent,
  getPersisted,
  set,
  toggle,
} as const;
