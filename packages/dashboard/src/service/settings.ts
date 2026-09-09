import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { type DashboardSettings, DEFAULT_DASHBOARD_SETTINGS, normalizeDashboardSettings } from "../shared";

type SettingsRow = {
  gradient: string;
  hiddenWidgets: string[];
  shortcuts: unknown;
  layout: unknown;
};

export type DashboardSettingsResult = {
  exists: boolean;
  settings: DashboardSettings;
};

const fromRow = (row: SettingsRow): DashboardSettings =>
  normalizeDashboardSettings({
    gradient: row.gradient,
    hiddenWidgets: row.hiddenWidgets,
    shortcuts: row.shortcuts,
    layout: row.layout,
  });

export const getUserSettings = async (userId: string): Promise<DashboardSettingsResult> => {
  const rows = await sql<SettingsRow[]>`
    SELECT
      gradient,
      hidden_widgets AS "hiddenWidgets",
      shortcuts,
      widget_layout AS layout
    FROM dashboard.user_settings
    WHERE user_id = ${userId}
  `;
  const row = rows[0];
  return row
    ? { exists: true, settings: fromRow(row) }
    : { exists: false, settings: normalizeDashboardSettings(DEFAULT_DASHBOARD_SETTINGS) };
};

export const saveUserSettings = async (userId: string, input: DashboardSettings): Promise<DashboardSettings> => {
  const settings = normalizeDashboardSettings(input);
  await sql`
    INSERT INTO dashboard.user_settings (user_id, gradient, hidden_widgets, shortcuts, widget_layout, updated_at)
    VALUES (
      ${userId},
      ${settings.gradient},
      ${toPgTextArray(settings.hiddenWidgets)}::text[],
      (${JSON.stringify(settings.shortcuts)}::text)::jsonb,
      (${JSON.stringify(settings.layout)}::text)::jsonb,
      now()
    )
    ON CONFLICT (user_id)
    DO UPDATE SET
      gradient = EXCLUDED.gradient,
      hidden_widgets = EXCLUDED.hidden_widgets,
      shortcuts = EXCLUDED.shortcuts,
      widget_layout = EXCLUDED.widget_layout,
      updated_at = now()
  `;
  return settings;
};

export const dashboardSettingsService = {
  get: getUserSettings,
  save: saveUserSettings,
};
