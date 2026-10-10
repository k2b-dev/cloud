import { sql } from "bun";
import {
  type DashboardBoardEntry,
  type DashboardSettings,
  DEFAULT_DASHBOARD_SETTINGS,
  isEmptyLegacyDashboardLayout,
  type LegacyDashboardLayout,
  normalizeDashboardBoard,
  normalizeDashboardShortcuts,
  normalizeLegacyDashboardLayout,
} from "../shared";

type SettingsRow = {
  shortcuts: unknown;
  board: unknown;
  hiddenWidgets: string[];
  layout: unknown;
};

export type DashboardSettingsResult = {
  exists: boolean;
  settings: DashboardSettings;
  /** Settings from before widgets had sizes that still wait to become a board; only while `board` is `null`. */
  legacy: LegacyDashboardLayout | null;
};

const EMPTY_LEGACY_LAYOUT = '{"widgets":[],"order":[]}';

export const getUserSettings = async (userId: string): Promise<DashboardSettingsResult> => {
  const rows = await sql<SettingsRow[]>`
    SELECT shortcuts, board, hidden_widgets AS "hiddenWidgets", widget_layout AS layout
    FROM dashboard.user_settings
    WHERE user_id = ${userId}
  `;
  const row = rows[0];
  if (!row) return { exists: false, settings: { ...DEFAULT_DASHBOARD_SETTINGS }, legacy: null };
  const settings = { shortcuts: normalizeDashboardShortcuts(row.shortcuts), board: normalizeDashboardBoard(row.board) };
  const legacy = settings.board === null ? normalizeLegacyDashboardLayout(row.hiddenWidgets, row.layout) : null;
  return { exists: true, settings, legacy: legacy && !isEmptyLegacyDashboardLayout(legacy) ? legacy : null };
};

/** Saves the shortcuts and the board; `board: null` makes the person follow the default board again. */
export const saveUserSettings = async (userId: string, input: DashboardSettings): Promise<DashboardSettings> => {
  const settings = { shortcuts: normalizeDashboardShortcuts(input.shortcuts), board: normalizeDashboardBoard(input.board) };
  const board = settings.board === null ? null : JSON.stringify(settings.board);
  // A saved board replaces whatever the old settings said, so they are never converted again.
  await sql`
    INSERT INTO dashboard.user_settings (user_id, shortcuts, board, updated_at)
    VALUES (${userId}, (${JSON.stringify(settings.shortcuts)}::text)::jsonb, (${board}::text)::jsonb, now())
    ON CONFLICT (user_id)
    DO UPDATE SET
      shortcuts = EXCLUDED.shortcuts,
      board = EXCLUDED.board,
      hidden_widgets = '{}'::text[],
      widget_layout = ${EMPTY_LEGACY_LAYOUT}::jsonb,
      updated_at = now()
  `;
  return settings;
};

/**
 * Stores the board converted from a person's old settings and clears those settings, so they are converted only
 * once. Only a row whose old settings are still waiting changes: a board saved meanwhile, or a return to the default
 * board saved meanwhile, stays. Returns the board that is stored now.
 */
export const adoptMigratedBoard = async (userId: string, board: DashboardBoardEntry[] | null): Promise<DashboardBoardEntry[] | null> => {
  const adopted = await sql<{ board: unknown }[]>`
    UPDATE dashboard.user_settings
    SET
      board = (${board === null ? null : JSON.stringify(board)}::text)::jsonb,
      hidden_widgets = '{}'::text[],
      widget_layout = ${EMPTY_LEGACY_LAYOUT}::jsonb,
      updated_at = now()
    WHERE user_id = ${userId}
      AND board IS NULL
      AND (cardinality(hidden_widgets) > 0 OR widget_layout <> ${EMPTY_LEGACY_LAYOUT}::jsonb)
    RETURNING board
  `;
  if (adopted[0]) return normalizeDashboardBoard(adopted[0].board);
  return (await getUserSettings(userId)).settings.board;
};

export const dashboardSettingsService = {
  get: getUserSettings,
  save: saveUserSettings,
  adoptMigratedBoard,
};
