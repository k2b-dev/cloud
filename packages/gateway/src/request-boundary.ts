import { DOMAIN_CHECK_PATH_PREFIX } from "@k2b/cloud/contracts/app-domains";

/** Reserved application-to-application routes never cross the public gateway. */
export const isInternalPath = (pathname: string, publicDomain = false): boolean => {
  try {
    return decodeURIComponent(pathname)
      .replaceAll("\\", "/")
      .split("/")
      .some(
        (part, index, parts) =>
          part === "_internal" ||
          (part === "_cloud" && (publicDomain || ["public", "ingress", "domain-check"].includes(parts[index + 1] ?? ""))),
      );
  } catch {
    // A malformed encoded path cannot be safely classified for an upstream.
    return true;
  }
};

/**
 * The application's address for a client request: always the application's
 * own origin. A path that starts with `//` would read as another host in a
 * relative reference, so leading slashes collapse to one, as route matching
 * already treats them. Everything after that, including inner `//` and
 * escapes, passes unchanged.
 */
export const upstreamUrl = (baseUrl: string, request: URL): URL => {
  const target = new URL(baseUrl);
  target.pathname = request.pathname.replace(/^\/+/, "/");
  target.search = request.search;
  target.hash = "";
  return target;
};

/** An expired check nonce is an ordinary app path, without reopening nested internal paths. */
export const isDomainCheckPath = (pathname: string): boolean => {
  if (!pathname.startsWith(DOMAIN_CHECK_PATH_PREFIX)) return false;
  try {
    const nonce = decodeURIComponent(pathname.slice(DOMAIN_CHECK_PATH_PREFIX.length));
    return !!nonce && !/[\\/]/.test(nonce) && nonce !== "_cloud" && nonce !== "_internal";
  } catch {
    return false;
  }
};
