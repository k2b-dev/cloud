import { formatNumber, parseNumber } from "./behavior/number";

/**
 * Numbers as people type and read them in v2 fields (a number `Input`, the number entry of a filter range): core reads
 * and shows them in the locale; this keeps what is sent exact. A number with more significant digits than a double
 * holds is refused instead of rounded, and a number is only ever sent as the plain decimal it was read as.
 */

/** Significant digits a number holds exactly (IEEE 754 double). */
const exactDigits = 15;

/** What text stands for: the plain decimal ("1500.5", "" when empty) and its value, or why it is no exact number. */
export type NumberReading = { plain: string; value: number | null } | { refused: "invalid" | "inexact" };

const significant = (text: string) => text.replace(/\D/g, "").replace(/^0+/, "").replace(/0+$/, "").length;

/** Typed text in the locale's form ("1.500,5" in German). */
export const readNumber = (text: string, locale: string): NumberReading => {
  const typed = text.trim();
  if (typed === "") return { plain: "", value: null };
  if (significant(typed) > exactDigits) return { refused: "inexact" };
  const value = parseNumber(typed, locale);
  if (value === null) return { refused: "invalid" };
  const plain = formatNumber(value, "en", { useGrouping: false, maximumFractionDigits: 20 });
  return Number(plain) === value ? { plain, value } : { refused: "inexact" };
};

/** A plain decimal an app gives ("1500.5"), as it is, or why a field cannot show it exactly ("1e-21"). */
export const readPlain = (text: string): NumberReading => {
  const given = text.trim();
  if (given === "") return { plain: "", value: null };
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(given)) return { refused: "invalid" };
  if (significant(given) > exactDigits) return { refused: "inexact" };
  return { plain: given, value: Number(given) };
};

/** A number as the locale shows it, every digit kept ("1.500,5" in German). */
export const showNumber = (value: number, locale: string) => formatNumber(value, locale, { maximumFractionDigits: 20 });
