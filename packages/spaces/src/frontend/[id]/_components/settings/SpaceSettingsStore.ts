/**
 * Space Settings Store
 *
 * Manages user preferences for spaces stored in cookies.
 * These are personal defaults that can be overridden via query params.
 */

import { cookies } from "@k2b/stdlib/browser";
import type { Priority } from "@/contracts";
import type { SpaceUserSettings, ViewType } from "@/settings-context";

export type { SpaceUserSettings, ViewType } from "@/settings-context";

/** Cookie name for space settings */
const COOKIE_NAME = "settings-app-spaces";

/** Cookie name for global widget settings (applies across all spaces) */
const WIDGET_SETTINGS_COOKIE = "settings-widgets";

/** Wrapper that holds per-space settings + global last-opened id */
export type AllSpacesSettings = {
  lastSpaceId: string | null;
  pinnedSpaceIds: string[];
  spaces: Record<string, SpaceUserSettings>;
};

/** Default settings for a single space */
export const DEFAULT_SPACE_SETTINGS: SpaceUserSettings = {
  view: "list",
  hideSettings: false,
};

/** Check if a string is a valid view type */
export const isValidView = (view: string | undefined): view is ViewType =>
  view === "list" || view === "table" || view === "kanban" || view === "calendar";

const DEFAULT_ALL: AllSpacesSettings = {
  lastSpaceId: null,
  pinnedSpaceIds: [],
  spaces: {},
};

const normalizePinnedSpaceIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && /^[0-9A-Za-z]{6}$/.test(id)))].slice(0, 200)
    : [];

/** Migrate old flat Record format to new wrapper format */
const migrateSettings = (raw: unknown): AllSpacesSettings => {
  if (!raw || typeof raw !== "object") return DEFAULT_ALL;
  const obj = raw as Record<string, unknown>;
  // New format has "spaces" key
  if ("spaces" in obj) {
    const parsed = obj as Partial<AllSpacesSettings>;
    return { ...DEFAULT_ALL, ...parsed, pinnedSpaceIds: normalizePinnedSpaceIds(parsed.pinnedSpaceIds) };
  }
  // Old format: flat Record<string, SpaceUserSettings> — migrate
  return {
    lastSpaceId: null,
    pinnedSpaceIds: [],
    spaces: obj as Record<string, SpaceUserSettings>,
  };
};

/** Read all settings from cookie (client-side) */
export const readAllSettings = (): AllSpacesSettings => migrateSettings(cookies.readJsonCookie(COOKIE_NAME, DEFAULT_ALL));

/** Write all settings to cookie (1 year expiry) */
export const writeAllSettings = (settings: AllSpacesSettings) => cookies.writeJsonCookie(COOKIE_NAME, settings);

/** Read settings for a specific space (client-side) */
export const readSpaceSettings = (spaceId: string): SpaceUserSettings => {
  const all = readAllSettings();
  return {
    ...DEFAULT_SPACE_SETTINGS,
    ...(all.spaces[spaceId] ?? {}),
  };
};

/** Write settings for a specific space (client-side) */
export const writeSpaceSettings = (spaceId: string, settings: Partial<SpaceUserSettings>) => {
  const all = readAllSettings();
  all.spaces[spaceId] = {
    ...DEFAULT_SPACE_SETTINGS,
    ...(all.spaces[spaceId] ?? {}),
    ...settings,
  };
  writeAllSettings(all);
};

/** Set the last opened space id (client-side) */
export const setLastSpaceId = (id: string) => {
  const all = readAllSettings();
  all.lastSpaceId = id;
  writeAllSettings(all);
};

export const setPinnedSpaceIds = (ids: string[]) => {
  writeAllSettings({ ...readAllSettings(), pinnedSpaceIds: normalizePinnedSpaceIds(ids) });
};

/** Parse raw cookie into AllSpacesSettings (server-side helper) */
const parseCookie = (cookieHeader: string | undefined): AllSpacesSettings => {
  if (!cookieHeader) return DEFAULT_ALL;
  try {
    const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (match) {
      return migrateSettings(JSON.parse(decodeURIComponent(match[1]!)));
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_ALL;
};

/** Parse settings for a specific space from cookie string (for server-side use) */
export const parseSpaceSettings = (cookieHeader: string | undefined, spaceId: string): SpaceUserSettings => {
  const all = parseCookie(cookieHeader);
  return { ...DEFAULT_SPACE_SETTINGS, ...(all.spaces[spaceId] ?? {}) };
};

/** Parse the last opened space id from cookie string (for server-side use) */
export const parseLastSpaceId = (cookieHeader: string | undefined): string | null => parseCookie(cookieHeader).lastSpaceId;

export const parsePinnedSpaceIds = (cookieHeader: string | undefined): string[] => parseCookie(cookieHeader).pinnedSpaceIds;

// =============================================================================
// Global Widget Settings (applies across all spaces)
// =============================================================================

/** Days ahead options for events widget */
export type EventsDaysAhead = 1 | 3 | 7 | 14;

/** Global widget settings */
export type WidgetSettings = {
  /** Events widget: days to look ahead */
  eventsDaysAhead: EventsDaysAhead;
  /** Tasks widget: minimum priority to show (null = all) */
  tasksMinPriority: Priority | null;
};

/** Default widget settings */
export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  eventsDaysAhead: 7,
  tasksMinPriority: null,
};

/** Check if a value is a valid EventsDaysAhead */
export const isValidEventsDaysAhead = (value: number): value is EventsDaysAhead =>
  value === 1 || value === 3 || value === 7 || value === 14;

/** Check if a value is a valid Priority */
export const isValidPriority = (value: string | null): value is Priority | null =>
  value === null || value === "urgent" || value === "high" || value === "medium" || value === "low";

/** Read widget settings from cookie (client-side) */
export const readWidgetSettings = (): WidgetSettings => {
  const parsed = cookies.readJsonCookie(WIDGET_SETTINGS_COOKIE, DEFAULT_WIDGET_SETTINGS);
  return {
    eventsDaysAhead: isValidEventsDaysAhead(parsed.eventsDaysAhead) ? parsed.eventsDaysAhead : DEFAULT_WIDGET_SETTINGS.eventsDaysAhead,
    tasksMinPriority: isValidPriority(parsed.tasksMinPriority) ? parsed.tasksMinPriority : DEFAULT_WIDGET_SETTINGS.tasksMinPriority,
  };
};

/** Write widget settings to cookie (1 year expiry) */
export const writeWidgetSettings = (settings: Partial<WidgetSettings>) => {
  const current = readWidgetSettings();
  const updated = { ...current, ...settings };
  cookies.writeJsonCookie(WIDGET_SETTINGS_COOKIE, updated);
};

/** Parse widget settings from cookie string (for server-side use) */
export const parseWidgetSettings = (cookieHeader: string | undefined): WidgetSettings => {
  if (!cookieHeader) return DEFAULT_WIDGET_SETTINGS;
  try {
    const match = cookieHeader.match(new RegExp(`${WIDGET_SETTINGS_COOKIE}=([^;]+)`));
    if (match) {
      const parsed = JSON.parse(decodeURIComponent(match[1]!));
      return {
        eventsDaysAhead: isValidEventsDaysAhead(parsed.eventsDaysAhead) ? parsed.eventsDaysAhead : DEFAULT_WIDGET_SETTINGS.eventsDaysAhead,
        tasksMinPriority: isValidPriority(parsed.tasksMinPriority) ? parsed.tasksMinPriority : DEFAULT_WIDGET_SETTINGS.tasksMinPriority,
      };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_WIDGET_SETTINGS;
};
