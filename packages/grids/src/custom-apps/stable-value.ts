export const stableCustomAppValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableCustomAppValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableCustomAppValue(item)]),
    );
  }
  return value;
};

export const stableCustomAppStringify = (value: unknown): string => JSON.stringify(stableCustomAppValue(value));

/** Layout is not a data/authorization dependency. Preserve all other rules. */
export const customAppFieldConfig = (field: { type: string; config: unknown }): unknown => {
  const config = field.config;
  if (field.type !== "object_list" || !config || typeof config !== "object" || !("fields" in config) || !Array.isArray(config.fields))
    return config;
  return {
    ...config,
    fields: config.fields.map((column: unknown) => {
      if (!column || typeof column !== "object") return column;
      return Object.fromEntries(Object.entries(column).filter(([key]) => key !== "width"));
    }),
  };
};
