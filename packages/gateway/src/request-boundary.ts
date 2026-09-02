/** Reserved application-to-application routes never cross the public gateway. */
export const isInternalPath = (pathname: string): boolean => {
  try {
    return decodeURIComponent(pathname).replaceAll("\\", "/").split("/").includes("_internal");
  } catch {
    // A malformed encoded path cannot be safely classified for an upstream.
    return true;
  }
};
