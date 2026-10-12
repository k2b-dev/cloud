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
  treeSort: "updated" | "created" | "title";
};

type AllNotebookSettings = {
  lastNotebookId: string | null;
  pinnedNotebookIds: string[];
  detailPanelOpen: boolean;
  /** Hides the desktop navigation in every notebook, for focused or private writing. */
  navigationHidden: boolean;
  /** Personal editor preference: Tab moves focus instead of indenting. */
  tabMovesFocus: boolean;
  /** Personal view preference: lifts the reading column in Write, Read-only and Book. */
  fullWidth: boolean;
  notebooks: Record<string, StoredNotebookSettings>;
};

type StoredNotebookSettings = Partial<Pick<NotebookSettings, "lastNoteId" | "richMode" | "treeSort">>;

const DEFAULT_SETTINGS: NotebookSettings = {
  lastNoteId: null,
  richMode: "rich",
  treeSort: "title",
};

const DEFAULT_ALL: AllNotebookSettings = {
  lastNotebookId: null,
  pinnedNotebookIds: [],
  detailPanelOpen: false,
  navigationHidden: false,
  tabMovesFocus: false,
  fullWidth: false,
  notebooks: {},
};

// --- Cookie helpers ---

const writeCookie = (data: AllNotebookSettings) => {
  const compact: Partial<AllNotebookSettings> = {};
  if (data.lastNotebookId !== DEFAULT_ALL.lastNotebookId) compact.lastNotebookId = data.lastNotebookId;
  if (data.pinnedNotebookIds.length > 0) compact.pinnedNotebookIds = data.pinnedNotebookIds;
  if (data.detailPanelOpen !== DEFAULT_ALL.detailPanelOpen) compact.detailPanelOpen = data.detailPanelOpen;
  if (data.navigationHidden !== DEFAULT_ALL.navigationHidden) compact.navigationHidden = data.navigationHidden;
  if (data.tabMovesFocus !== DEFAULT_ALL.tabMovesFocus) compact.tabMovesFocus = data.tabMovesFocus;
  if (data.fullWidth !== DEFAULT_ALL.fullWidth) compact.fullWidth = data.fullWidth;
  if (Object.keys(data.notebooks).length > 0) compact.notebooks = data.notebooks;
  cookies.writeJsonCookie(COOKIE_NAME, compact);
};

const isTreeSort = (value: unknown): value is NotebookSettings["treeSort"] =>
  value === "updated" || value === "created" || value === "title";

const isPublicNotebookId = (value: unknown): value is string => typeof value === "string" && /^[0-9A-Za-z]{6}$/.test(value);

const normalizePinnedNotebookIds = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter(isPublicNotebookId))].slice(0, MAX_PINNED_NOTEBOOKS) : [];

const compactNotebookSettings = (settings: Partial<NotebookSettings>): StoredNotebookSettings => {
  const compact: StoredNotebookSettings = {};
  if (typeof settings.lastNoteId === "string" && settings.lastNoteId.length > 0) compact.lastNoteId = settings.lastNoteId;
  if (settings.richMode && settings.richMode !== DEFAULT_SETTINGS.richMode) compact.richMode = settings.richMode;
  if (isTreeSort(settings.treeSort) && settings.treeSort !== DEFAULT_SETTINGS.treeSort) compact.treeSort = settings.treeSort;
  return compact;
};

/**
 * Keeps the valid, known values of one notebook's stored settings. Values of removed features, such as the sort of
 * the former Navigator, are dropped, so the next write leaves them out of the cookie.
 */
const readNotebookEntry = (value: unknown): StoredNotebookSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entry = value as Record<string, unknown>;
  return compactNotebookSettings({
    lastNoteId: typeof entry.lastNoteId === "string" ? entry.lastNoteId : undefined,
    richMode: entry.richMode === "source" || entry.richMode === "rich" ? entry.richMode : undefined,
    treeSort: isTreeSort(entry.treeSort) ? entry.treeSort : undefined,
  });
};

const normalizeSettings = (value: unknown): AllNotebookSettings => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return DEFAULT_ALL;
  const parsed = value as Partial<AllNotebookSettings>;
  const rawNotebooks = parsed.notebooks;
  const notebooks =
    rawNotebooks && typeof rawNotebooks === "object" && !Array.isArray(rawNotebooks)
      ? Object.fromEntries(
          Object.entries(rawNotebooks as Record<string, unknown>)
            .map(([id, entry]) => [id, readNotebookEntry(entry)] as const)
            .filter(([id, entry]) => id.length > 0 && Object.keys(entry).length > 0)
            .slice(-MAX_NOTEBOOK_SETTINGS),
        )
      : {};

  return {
    lastNotebookId: typeof parsed.lastNotebookId === "string" ? parsed.lastNotebookId : null,
    pinnedNotebookIds: normalizePinnedNotebookIds(parsed.pinnedNotebookIds),
    detailPanelOpen: parsed.detailPanelOpen === true,
    navigationHidden: parsed.navigationHidden === true,
    tabMovesFocus: parsed.tabMovesFocus === true,
    fullWidth: parsed.fullWidth === true,
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

const notebookSettingsFor = (all: AllNotebookSettings, notebookId: string): StoredNotebookSettings => all.notebooks[notebookId] ?? {};

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
    treeSort: isTreeSort(notebook.treeSort) ? notebook.treeSort : DEFAULT_SETTINGS.treeSort,
  };
};

/**
 * Merges and writes notebook-specific UI settings for the current notebook id.
 */
export const writeSettings = (notebookId: string, patch: Partial<NotebookSettings>) => {
  const hasCookieBackedPatch = "lastNoteId" in patch || "richMode" in patch || "treeSort" in patch;
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

/** Reads and writes the global hidden-navigation preference; SSR reads it through `parseNavigationHidden`. */
export const readNavigationHidden = (): boolean => readCookie().navigationHidden;

export const writeNavigationHidden = (navigationHidden: boolean) => {
  writeCookie({
    ...readCookie(),
    navigationHidden,
  });
};

/** Reads and writes the personal Tab key preference for the note editor. */
export const readTabMovesFocus = (): boolean => readCookie().tabMovesFocus;

export const setTabMovesFocus = (tabMovesFocus: boolean) => {
  writeCookie({
    ...readCookie(),
    tabMovesFocus,
  });
};

/** Reads and writes the personal reading-column preference. */
export const readFullWidth = (): boolean => readCookie().fullWidth;

export const setFullWidth = (fullWidth: boolean) => {
  writeCookie({
    ...readCookie(),
    fullWidth,
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
    treeSort: isTreeSort(notebook.treeSort) ? notebook.treeSort : DEFAULT_SETTINGS.treeSort,
  };
};

/**
 * Parses the global detail-panel open state from a raw cookie header for SSR.
 * Defaults to false — first-time users see the panel closed.
 */
export const parseDetailPanelOpen = (cookieHeader: string | undefined): boolean => parseCookieHeader(cookieHeader).detailPanelOpen === true;

/** Parses the hidden-navigation preference so the first paint never shows the note tree. */
export const parseNavigationHidden = (cookieHeader: string | undefined): boolean => parseCookieHeader(cookieHeader).navigationHidden;

/** Parses the personal full-width preference for the first paint. */
export const parseFullWidth = (cookieHeader: string | undefined): boolean => parseCookieHeader(cookieHeader).fullWidth;

/**
 * Parses only the last notebook id from a raw cookie header for SSR redirects.
 */
export const parseLastNotebookId = (cookieHeader: string | undefined): string | null => {
  return parseCookieHeader(cookieHeader).lastNotebookId;
};

/** Parses pinned notebook ids for SSR-stable ordering on the overview. */
export const parsePinnedNotebookIds = (cookieHeader: string | undefined): string[] => parseCookieHeader(cookieHeader).pinnedNotebookIds;
