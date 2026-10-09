/** Reserved application-to-application routes never cross the public gateway. */
export const isInternalPath = (pathname: string): boolean => {
  try {
    return decodeURIComponent(pathname).replaceAll("\\", "/").split("/").includes("_internal");
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
