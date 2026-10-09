import { parseLastGridsPath } from "./_components/sidebar/GridsSettingsStore";

export const recentBasePath = (cookieHeader: string | undefined, bases: readonly { shortId: string }[]): string | null => {
  const lastPath = parseLastGridsPath(cookieHeader);
  if (!lastPath) return null;
  const lastUrl = new URL(lastPath, "http://grids.local");
  // Judge the resolved path: dot segments in the cookie could otherwise leave Grids, even for `//host`.
  if (!lastUrl.pathname.startsWith("/app/grids/")) return null;
  const baseId = lastUrl.pathname.split("/")[3] ?? "";
  if (!bases.some((base) => base.shortId === baseId)) return null;
  return `${lastUrl.pathname}${lastUrl.search}`;
};
