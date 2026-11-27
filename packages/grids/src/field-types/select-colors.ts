import { z } from "zod";

/** The colour names a select option may carry. */
export const SELECT_COLOR_NAMES = ["blue", "cyan", "gray", "green", "orange", "purple", "red", "yellow"] as const;

export type SelectColorName = (typeof SELECT_COLOR_NAMES)[number];

/** The hex value each colour name shows as. */
export const NAMED_SELECT_COLORS = {
  blue: "#0000ff",
  cyan: "#00ffff",
  gray: "#808080",
  green: "#008000",
  orange: "#ffa500",
  purple: "#800080",
  red: "#ff0000",
  yellow: "#ffff00",
} as const satisfies Record<SelectColorName, string>;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * A select option's colour: a hex colour (`#2563eb`, `#25e`) or one of the names above. Writing anything else is
 * refused (`invalidSelectColor`); reading drops it (`.catch` where the schema is used), since configurations written
 * before colours were checked may hold one.
 */
/** The longest colour: `#rrggbb`. */
export const SELECT_COLOR_MAX_LENGTH = 7;

export const SelectColorSchema = z.union([z.string().max(SELECT_COLOR_MAX_LENGTH).regex(HEX_COLOR), z.enum(SELECT_COLOR_NAMES)]);

/**
 * A stored colour as it is read: a hex colour stays, a name becomes its hex value, anything else (written before
 * colours were checked) is no colour.
 */
export const normalizeSelectColor = (color: unknown): string | undefined => {
  if (typeof color !== "string") return undefined;
  const value = color.trim();
  if (HEX_COLOR.test(value)) return value;
  const name = SELECT_COLOR_NAMES.find((each) => each === value.toLowerCase());
  return name ? NAMED_SELECT_COLORS[name] : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The select configurations inside a field's configuration: its own, or those of a list's select columns. */
const selectConfigsOf = (type: string, config: unknown): unknown[] => {
  if (type === "select") return [config];
  if (type !== "object_list" || !isRecord(config)) return [];
  return listOf(config.fields).flatMap((column) => (isRecord(column) && column.type === "select" ? [column.config] : []));
};

/**
 * The first colour a written field configuration may not hold, as JSON for the message of a 400; null when every
 * colour is one. Covers select fields and the select columns of lists.
 */
export const invalidSelectColor = (type: string, config: unknown): string | null => {
  for (const select of selectConfigsOf(type, config))
    for (const option of isRecord(select) ? listOf(select.options) : []) {
      const color = isRecord(option) ? option.color : undefined;
      if (color !== undefined && !SelectColorSchema.safeParse(color).success) return JSON.stringify(color);
    }
  return null;
};

const normalizedOptions = (select: Record<string, unknown>): Record<string, unknown> => {
  if (!Array.isArray(select.options)) return select;
  return {
    ...select,
    options: select.options.map((option) => {
      if (!isRecord(option) || option.color === undefined) return option;
      const { color, ...rest } = option;
      const normalized = normalizeSelectColor(color);
      return normalized ? { ...rest, color: normalized } : rest;
    }),
  };
};

/**
 * A stored field configuration as it is read: every select option colour as hex ("blue" becomes "#0000ff"), and a
 * colour that is none dropped. Other configurations stay as they are.
 */
export const withNormalizedSelectColors = (type: string, config: Record<string, unknown>): Record<string, unknown> => {
  if (type === "select") return normalizedOptions(config);
  if (type !== "object_list" || !Array.isArray(config.fields)) return config;
  return {
    ...config,
    fields: config.fields.map((column) =>
      isRecord(column) && column.type === "select" && isRecord(column.config)
        ? { ...column, config: normalizedOptions(column.config) }
        : column,
    ),
  };
};
