import { formatDescriptionNumber } from "@k2b/cloud/descriptions";
import type { JsonValue } from "./examples/types";

/** A portable number format (`{ style, currency, unit, decimals, compact }`) as text, in the page's locale. */
export const formatNumber = (value: number, format: JsonValue | undefined, locale = "en"): string =>
  formatDescriptionNumber(value, format, locale);
