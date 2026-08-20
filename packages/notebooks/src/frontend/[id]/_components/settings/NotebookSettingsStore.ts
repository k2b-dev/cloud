/**
 * Notebook Settings Store
 *
 * Cookie-based user preferences for notebooks.
 */

import { cookies } from "@k2b/stdlib/browser";

const COOKIE_NAME = "settings-app-notebooks";
const MAX_NOTEBOOK_SETTINGS = 25;
const MAX_PINNED_NOTEBOOKS = 200;

export type NotebookSettings = {
  lastNoteId: string | null;
  richMode: "rich" | "source";
  sidebarMode: "simple" | "navigator";
  navigatorSort: "updated" | "created" | "title";
};

type AllNotebookSettings = {
  lastNotebookId: string | null;
  pinnedNotebookIds: string[];
  sidebarMode: NotebookSettings["sidebarMode"];
  detailPanelOpen: boolean;
  notebooks: Record<string, Partial<Pick<NotebookSettings, "lastNoteId" | "richMode" | "navigatorSort">>>;
};

const DEFAULT_SETTINGS: NotebookSettings = {
  lastNoteId: null,
  richMode: "rich",
  sidebarMode: "simple",
  navigatorSort: "updated",
};

const DEFAULT_ALL: AllNotebookSettings = {
  lastNotebookId: null,
  pinnedNotebookIds: [],
  sidebarMode: "simple",
  detailPanelOpen: false,
  notebooks: {},
};

// --- Cookie helpers ---

const writeCookie = (data: AllNotebookSettings) => cookies.writeJsonCookie(COOKIE_NAME, data);

const isSidebarMode = (value: unknown): value is NotebookSettings["sidebarMode"] => value === "simple" || value === "navigator";

const isNavigatorSort = (value: unknown): value is NotebookSettings["navigatorSort"] =>
  value === "updated" || value === "created" || value === "title";

const isPublicNotebookId = (value: unknown): value is string => typeof value === "string" && /^[0-9A-Za-z]{6}$/.test(value);

const normalizePinnedNotebookIds = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter(isPublicNotebookId))].slice(0, MAX_PINNED_NOTEBOOKS) : [];

const normalizeSettings = (value: unknown): AllNotebookSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_ALL;
  const parsed = value as Partial<AllNotebookSettings>;
  const rawNotebooks = parsed.notebooks;
  const notebooks =
    rawNotebooks && typeof rawNotebooks === "object" && !Array.isArray(rawNotebooks)
      ? Object.fromEntries(
          Object.entries(rawNotebooks)
            .filter(([id, entry]) => id.length > 0 && entry && typeof entry === "object" && !Array.isArray(entry))
            .slice(-MAX_NOTEBOOK_SETTINGS),
        )
      : {};

  return {
    lastNotebookId: typeof parsed.lastNotebookId === "string" ? parsed.lastNotebookId : null,
    pinnedNotebookIds: normalizePinnedNotebookIds(parsed.pinnedNotebookIds),
    sidebarMode: isSidebarMode(parsed.sidebarMode) ? parsed.sidebarMode : DEFAULT_ALL.sidebarMode,
    detailPanelOpen: parsed.detailPanelOpen === true,
    notebooks,
  };
};

const readCookie = (): AllNotebookSettings => normalizeSettings(cookies.readJsonCookie(COOKIE_NAME, DEFAULT_ALL));

const parseCookieHeader = (cookieHeader: string | undefined): AllNotebookSettings => {
  if (!cookieHeader) return DEFAULT_ALL;
  try {
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (!match) return DEFAULT_ALL;
    return normalizeSettings(JSON.parse(decodeURIComponent(match[1]!)));
  } catch {
    return DEFAULT_ALL;
  }
};

const compactNotebookSettings = (
  settings: Partial<NotebookSettings>,
): Partial<Pick<NotebookSettings, "lastNoteId" | "richMode" | "navigatorSort">> => {
  const compact: Partial<Pick<NotebookSettings, "lastNoteId" | "richMode" | "navigatorSort">> = {};
  if (typeof settings.lastNoteId === "string" && settings.lastNoteId.length > 0) compact.lastNoteId = settings.lastNoteId;
  if (settings.richMode && settings.richMode !== DEFAULT_SETTINGS.richMode) compact.richMode = settings.richMode;
  if (isNavigatorSort(settings.navigatorSort) && settings.navigatorSort !== DEFAULT_SETTINGS.navigatorSort) {
    compact.navigatorSort = settings.navigatorSort;
  }
  return compact;
};

const notebookSettingsFor = (all: AllNotebookSettings, notebookId: string): Partial<NotebookSettings> => {
  const value = all.notebooks[notebookId];
  if (!value || typeof value !== "object") return {};
  const result: Partial<NotebookSettings> = {};
  if (typeof value.lastNoteId === "string") result.lastNoteId = value.lastNoteId;
  if (value.richMode === "source" || value.richMode === "rich") result.richMode = value.richMode;
  if (isNavigatorSort(value.navigatorSort)) result.navigatorSort = value.navigatorSort;
  return result;
};

// --- Client-side ---

/**
 * Reads notebook-specific UI settings in the browser.
 */
export const readSettings = (notebookId: string): NotebookSettings => {
  const all = readCookie();
  const notebook = notebookSettingsFor(all, notebookId);
  return {
    ...DEFAULT_SETTINGS,
    ...notebook,
    sidebarMode: isSidebarMode(all.sidebarMode) ? all.sidebarMode : DEFAULT_SETTINGS.sidebarMode,
    navigatorSort: isNavigatorSort(notebook.navigatorSort) ? notebook.navigatorSort : DEFAULT_SETTINGS.navigatorSort,
  };
};

/**
 * Merges and writes notebook-specific UI settings for the current notebook id.
 */
export const writeSettings = (notebookId: string, patch: Partial<NotebookSettings>) => {
  const hasCookieBackedPatch = "lastNoteId" in patch || "richMode" in patch || "sidebarMode" in patch || "navigatorSort" in patch;
  if (!hasCookieBackedPatch) return;
  const all = readCookie();
  const current = readSettings(notebookId);
  const next = { ...current, ...patch };
  const notebookSettings = compactNotebookSettings(next);
  const notebooks = { ...all.notebooks };
  delete notebooks[notebookId];
  if (Object.keys(notebookSettings).length > 0) notebooks[notebookId] = notebookSettings;

  const boundedNotebooks = Object.fromEntries(Object.entries(notebooks).slice(-MAX_NOTEBOOK_SETTINGS));

  writeCookie({
    ...all,
    sidebarMode: next.sidebarMode,
    notebooks: boundedNotebooks,
  });
};

/**
 * Persists the last opened notebook id for redirect/bootstrap flows.
 */
export const setLastNotebookId = (id: string) => {
  const all = readCookie();
  writeCookie({
    ...all,
    lastNotebookId: id,
  });
};

/** Reads and writes the overview's user-defined notebook order. */
export const readPinnedNotebookIds = (): string[] => readCookie().pinnedNotebookIds;

export const setPinnedNotebookIds = (ids: string[]) => {
  writeCookie({
    ...readCookie(),
    pinnedNotebookIds: normalizePinnedNotebookIds(ids),
  });
};

/** Persists the global detail-panel preference for SSR-stable reloads. */
export const setDetailPanelOpen = (open: boolean) => {
  writeCookie({
    ...readCookie(),
    detailPanelOpen: open,
  });
};

// --- Server-side ---

/**
 * Parses notebook settings from a raw cookie header for SSR rendering.
 */
export const parseSettings = (cookieHeader: string | undefined, notebookId: string): NotebookSettings => {
  const all = parseCookieHeader(cookieHeader);
  const notebook = notebookSettingsFor(all, notebookId);
  return {
    ...DEFAULT_SETTINGS,
    ...notebook,
    sidebarMode: isSidebarMode(all.sidebarMode) ? all.sidebarMode : DEFAULT_SETTINGS.sidebarMode,
    navigatorSort: isNavigatorSort(notebook.navigatorSort) ? notebook.navigatorSort : DEFAULT_SETTINGS.navigatorSort,
  };
};

/**
 * Parses the global detail-panel open state from a raw cookie header for SSR.
 * Defaults to false — first-time users see the panel closed.
 */
export const parseDetailPanelOpen = (cookieHeader: string | undefined): boolean => parseCookieHeader(cookieHeader).detailPanelOpen === true;

/**
 * Parses only the last notebook id from a raw cookie header for SSR redirects.
 */
export const parseLastNotebookId = (cookieHeader: string | undefined): string | null => {
  return parseCookieHeader(cookieHeader).lastNotebookId;
};

/** Parses pinned notebook ids for SSR-stable ordering on the overview. */
export const parsePinnedNotebookIds = (cookieHeader: string | undefined): string[] => parseCookieHeader(cookieHeader).pinnedNotebookIds;
