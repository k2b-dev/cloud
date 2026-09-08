import type { PublicField as Field } from "../../../api/public-dto";
import { gridsFieldMessages } from "./messages";

export const FIELD_CHOICE_GROUPS = [
  { value: "basic", label: "Basic" },
  { value: "relations", label: "Relations" },
  { value: "computed", label: "Computed" },
  { value: "system", label: "System" },
  { value: "files", label: "Files" },
] as const;

const SYSTEM_FIELD_TYPES = new Set(["id", "created_at", "created_by", "updated_at", "updated_by"]);

export const fieldTypeGroups = (type: string): readonly string[] => {
  if (type === "file") return ["files"];
  if (type === "relation") return ["relations"];
  if (type === "lookup" || type === "rollup") return ["relations", "computed"];
  if (type === "formula" || type === "html_template") return ["computed"];
  if (SYSTEM_FIELD_TYPES.has(type)) return ["system"];
  return ["basic"];
};

export const fieldChoiceGroupsFor = (fields: readonly Pick<Field, "type">[], extra: readonly string[] = [], locale = "en") => {
  const available = new Set([...fields.flatMap((field) => fieldTypeGroups(field.type)), ...extra]);
  const { t } = gridsFieldMessages.resolve([locale]);
  const labels: Record<string, string> = {
    basic: t.basicGroup,
    relations: t.relationsGroup,
    computed: t.computedGroup,
    system: t.systemGroup,
    files: t.filesGroup,
  };
  return FIELD_CHOICE_GROUPS.filter((group) => available.has(group.value)).map((group) => ({
    ...group,
    label: labels[group.value] ?? group.label,
  }));
};

export const FIELD_TYPE_ICONS: Record<string, string> = {
  text: "ti ti-typography",
  longtext: "ti ti-align-left",
  number: "ti ti-number",
  decimal: "ti ti-decimal",
  boolean: "ti ti-checkbox",
  date: "ti ti-calendar",
  select: "ti ti-tags",
  principal: "ti ti-users-group",
  id: "ti ti-id",
  percent: "ti ti-percentage",
  duration: "ti ti-clock-hour-4",
  json: "ti ti-braces",
  file: "ti ti-paperclip",
  relation: "ti ti-link",
  lookup: "ti ti-corner-down-right",
  rollup: "ti ti-math-function",
  formula: "ti ti-calculator",
  html_template: "ti ti-template",
  created_at: "ti ti-clock-plus",
  updated_at: "ti ti-clock-edit",
  created_by: "ti ti-user-plus",
  updated_by: "ti ti-user-edit",
};

export const fieldTypeLabel = (type: string, locale = "en"): string => gridsFieldMessages.resolve([locale]).t.typeLabel({ type });

export const fieldTypeIcon = (type: string, customIcon?: string | null): string => customIcon || FIELD_TYPE_ICONS[type] || "ti ti-columns";

export const fieldOption = (field: Field, description = "Column", locale = "en") => ({
  id: field.id,
  label: field.name,
  description: `${description} · ${fieldTypeLabel(field.type, locale)}`,
  icon: fieldTypeIcon(field.type, field.icon),
  groups: fieldTypeGroups(field.type),
});
