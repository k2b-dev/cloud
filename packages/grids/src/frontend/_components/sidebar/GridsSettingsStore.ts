import { cookies } from "@k2b/stdlib/browser";

const COOKIE_NAME = "settings-app-grids";
export const NAVIGATION_EXPANSION_EVENT = "grids:navigation-expansion";

type GridsSettings = {
  lastPath: string | null;
  /** The bases opened last, newest first: the switcher's "Zuletzt geöffnet". */
  recentBases: string[];
  documentViewMode: GridsDocumentViewMode;
  navigation: Array<{ base: string; expanded: string[] }>;
};

/** How many bases the switcher names as opened last. */
export const RECENT_BASES = 5;
const BASE_ID = /^[A-Za-z0-9]{6}$/;

const DEFAULT_SETTINGS: GridsSettings = {
  lastPath: null,
  recentBases: [],
  documentViewMode: "list",
  navigation: [],
};

export type GridsDocumentViewMode = "list" | "folders";

const normalizeDocumentViewMode = (value: unknown): GridsDocumentViewMode => (value === "folders" ? "folders" : "list");

const normalizeSettings = (raw: unknown): GridsSettings => {
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
  const candidate = raw as Partial<GridsSettings>;
  return {
    lastPath: typeof candidate.lastPath === "string" ? candidate.lastPath : null,
    recentBases: Array.isArray(candidate.recentBases)
      ? [...new Set(candidate.recentBases.filter((id): id is string => typeof id === "string" && BASE_ID.test(id)))].slice(0, RECENT_BASES)
      : [],
    documentViewMode: normalizeDocumentViewMode(candidate.documentViewMode),
    navigation: Array.isArray(candidate.navigation)
      ? candidate.navigation.flatMap((entry) =>
          entry && typeof entry.base === "string" && BASE_ID.test(entry.base) && Array.isArray(entry.expanded)
            ? [
                {
                  base: entry.base,
                  expanded: [
                    ...new Set(
                      entry.expanded.filter(
                        (id): id is string =>
                          typeof id === "string" &&
                          /^(group:[A-Za-z0-9]{6}|type:(table|view|form|documentTemplate|workflow|customApp))$/.test(id),
                      ),
                    ),
                  ],
                },
              ]
            : [],
        )
      : [],
  };
};

const isSafeGridsPath = (path: string): boolean => path === "/app/grids" || path.startsWith("/app/grids/");

const readGridsSettings = (): GridsSettings => normalizeSettings(cookies.readJsonCookie(COOKIE_NAME, DEFAULT_SETTINGS));

// Reserve room for name/attributes below the usual 4 KiB cookie limit.
export const GRIDS_SETTINGS_COOKIE_BUDGET = 3500;
export const boundGridsSettings = (settings: GridsSettings): GridsSettings => {
  const next = { ...settings, navigation: [...settings.navigation] };
  const size = () => encodeURIComponent(JSON.stringify(next)).length;
  while (size() > GRIDS_SETTINGS_COOKIE_BUDGET && next.navigation.length) next.navigation.pop();
  if (size() > GRIDS_SETTINGS_COOKIE_BUDGET) next.lastPath = null;
  return next;
};
const writeGridsSettings = (settings: GridsSettings) => cookies.writeJsonCookie(COOKIE_NAME, boundGridsSettings(settings));

export const setNavigationExpansion = (base: string, expanded: string[]) => {
  const settings = readGridsSettings();
  writeGridsSettings(
    normalizeSettings({ ...settings, navigation: [{ base, expanded }, ...settings.navigation.filter((entry) => entry.base !== base)] }),
  );
  window.dispatchEvent(new Event(NAVIGATION_EXPANSION_EVENT));
};

export const setLastGridsPath = (path: string) => {
  if (!isSafeGridsPath(path) || path === "/app/grids") return;
  const settings = readGridsSettings();
  // the base the path opens leads the ones opened last
  const base = path.split(/[/?#]/)[3] ?? "";
  const recentBases = BASE_ID.test(base) ? [base, ...settings.recentBases.filter((id) => id !== base)] : settings.recentBases;
  writeGridsSettings(normalizeSettings({ ...settings, lastPath: path, recentBases }));
};

export const setDocumentViewMode = (mode: GridsDocumentViewMode) => {
  writeGridsSettings({ ...readGridsSettings(), documentViewMode: mode });
};

const parseCookie = (cookieHeader: string | undefined): GridsSettings => {
  if (!cookieHeader) return DEFAULT_SETTINGS;
  try {
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (match) return normalizeSettings(JSON.parse(decodeURIComponent(match[1]!)));
  } catch {
    // Ignore invalid user cookies.
  }
  return DEFAULT_SETTINGS;
};

export const parseLastGridsPath = (cookieHeader: string | undefined): string | null => {
  const path = parseCookie(cookieHeader).lastPath;
  return path && isSafeGridsPath(path) ? path : null;
};

/** The bases opened last, newest first, as the cookie names them; whether each may still be opened is the caller's. */
export const parseRecentBases = (cookieHeader: string | undefined): string[] => parseCookie(cookieHeader).recentBases;

export const parseDocumentViewMode = (cookieHeader: string | undefined): GridsDocumentViewMode =>
  parseCookie(cookieHeader).documentViewMode;

export const parseNavigationExpansion = (cookieHeader: string | undefined, base: string): string[] | undefined =>
  parseCookie(cookieHeader).navigation.find((entry) => entry.base === base)?.expanded;
