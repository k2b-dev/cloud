export const RESOURCE_SHORT_ID_PATTERN = /^[0-9A-Za-z]{6}$/;

export const isResourceShortId = (value: unknown): value is string => typeof value === "string" && RESOURCE_SHORT_ID_PATTERN.test(value);
