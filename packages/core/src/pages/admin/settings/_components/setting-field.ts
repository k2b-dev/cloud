export type SettingValueSource = "custom" | "env" | "default";

/** One registry setting as the admin settings forms read it. */
export type SettingFieldDef = {
  updatedAt?: string | null;
  updatedBy?: { id: string; name: string } | null;
  key: string;
  label: string;
  description: string;
  kind:
    | "string"
    | "text"
    | "email"
    | "url"
    | "secret"
    | "image"
    | "boolean"
    | "number"
    | "enum"
    | "string_list"
    | "number_list"
    | "cron"
    | "timezone"
    | "template";
  value: unknown;
  default: unknown;
  resetValue: unknown;
  valueSource: SettingValueSource;
  resetValueSource: Exclude<SettingValueSource, "custom">;
  isCustom: boolean;
  /** A stored row exists that this application cannot read; `value` is the fallback in use. */
  unreadable: boolean;
  group: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  placeholder?: string;
  templateVars?: readonly string[];
};
