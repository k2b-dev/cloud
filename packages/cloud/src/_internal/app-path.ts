/** An absolute path on the current origin: one leading slash, no backslash or whitespace. */
export const SAME_ORIGIN_PATH = /^\/(?![\/\\])[^\\\s]*$/;

/** A route as the gateway reads it: trimmed and without empty segments, so `//pwa/x/` is `/pwa/x`. */
export const canonicalRoute = (route: string): string => {
  const trimmed = route.trim();
  return trimmed.startsWith("/") ? `/${trimmed.split("/").filter(Boolean).join("/")}` : trimmed;
};

/**
 * Whether an application path stays below one of the app's own `routes`. It is
 * checked on the path the browser actually requests, after dot segments, and
 * never starts with `//`, which a URL resolver reads as another host.
 */
export const isOwnAppPath = (href: string, routes: readonly string[]): boolean => {
  if (!SAME_ORIGIN_PATH.test(href)) return false;
  const path = new URL(href, "https://cloud.invalid").pathname;
  return (
    !path.startsWith("//") &&
    routes.some((route) => {
      const prefix = canonicalRoute(route);
      return prefix === "/" || path === prefix || path.startsWith(`${prefix}/`);
    })
  );
};
