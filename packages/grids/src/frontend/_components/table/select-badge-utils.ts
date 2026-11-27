import { normalizeSelectColor } from "../../../field-types/select-colors";

type SelectOption = {
  id: string;
  label: string;
  color?: string;
  description?: string;
};

export type SelectBadgeItem = {
  id: string;
  label: string;
  color?: string;
  known: boolean;
};

type SelectBadgeStyle = Record<string, string>;

const optionList = (fieldConfig?: Record<string, unknown>): SelectOption[] =>
  ((fieldConfig?.options as SelectOption[] | undefined) ?? []).filter(
    (option) => typeof option.id === "string" && typeof option.label === "string",
  );

const normalizeIds = (value: unknown, type: string): string[] => {
  if (value === null || value === undefined || value === "") return [];
  if (type === "select") {
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    return typeof value === "string" && value.length > 0 ? [value] : [];
  }
  return [];
};

export const selectBadgeItems = (value: unknown, type: string, fieldConfig?: Record<string, unknown>): SelectBadgeItem[] => {
  if (type !== "select") return [];
  const options = new Map(optionList(fieldConfig).map((option) => [option.id, option]));
  return normalizeIds(value, type).map((id) => {
    const option = options.get(id);
    return option ? { id, label: option.label, color: normalizeSelectColor(option.color), known: true } : { id, label: id, known: false };
  });
};

const expandHex = (color: string): string => {
  if (color.length !== 4) return color;
  return `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
};

const hexToRgb = (color: string): { r: number; g: number; b: number } | null => {
  const hex = expandHex(color).slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
};

export const selectBadgeStyle = (color?: string): SelectBadgeStyle => {
  const normalized = normalizeSelectColor(color);
  if (!normalized) return {};
  const rgb = hexToRgb(normalized);
  if (!rgb) return {};
  const { r, g, b } = rgb;
  return {
    "background-color": `rgba(${r}, ${g}, ${b}, 0.12)`,
    "border-color": `rgba(${r}, ${g}, ${b}, 0.34)`,
    color: `rgb(${r}, ${g}, ${b})`,
  };
};
