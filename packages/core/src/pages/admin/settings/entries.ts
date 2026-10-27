import { settingsService } from "@k2b/cloud/services";
import type { SettingFieldDef } from "./_components/CoreSettingsForm.island";

/**
 * Pull the SettingFieldDef list for a given group from the global settings
 * registry. Returns entries with current values resolved (DB → env → default).
 */
export const buildEntries = async (group: string, locale: string): Promise<SettingFieldDef[]> => {
  const result = await settingsService.entry.list({ filter: { group }, locale });
  return result.items.map((item) => ({
    updatedAt: item.updatedAt,
    updatedBy: item.updatedBy,
    key: item.key,
    label: item.label,
    description: item.description,
    kind: item.kind as SettingFieldDef["kind"],
    value: item.value,
    default: item.default,
    resetValue: item.resetValue,
    valueSource: item.valueSource,
    resetValueSource: item.resetValueSource,
    isCustom: item.isCustom,
    unreadable: item.unreadable,
    group: item.group,
    options: item.options,
    min: item.min,
    max: item.max,
    placeholder: item.placeholder,
    templateVars: item.templateVars,
  }));
};
