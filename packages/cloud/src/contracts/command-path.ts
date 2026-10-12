/** Commands carry small public references/options, never document bodies or secrets. */
export const COMMAND_MAX_URL_LENGTH = 8192;

/** The same-origin path rule of `CommandPathSchema`, without its length limit. */
export const isCommandPathSyntax = (value: string): boolean => {
  if (!value.startsWith("/") || /[\\\u0000-\u0020]/u.test(value)) return false;
  try {
    const url = new URL(value, "https://cloud.invalid");
    // Dot segments can resolve to `//host`, which a browser reads as another host.
    return url.origin === "https://cloud.invalid" && !url.pathname.startsWith("//");
  } catch {
    return false;
  }
};

/** Whether `value` is a Cloud path that `CommandPathSchema` accepts; loads no validators. */
export const isCommandPath = (value: string): boolean => (value.length <= 2000 || [...value].length <= 2000) && isCommandPathSyntax(value);
