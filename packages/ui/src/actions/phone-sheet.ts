/** Phones, where a menu or a date calendar opens as a bottom sheet instead of beside its trigger. */
export const PHONE_SHEET_QUERY = "(max-width: 47.999rem)";

export const prefersMenuSheet = (): boolean => typeof matchMedia === "function" && matchMedia(PHONE_SHEET_QUERY).matches;
