const decimalText = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

const numberInputDecimalSeparator = (locale: string): string =>
  new Intl.NumberFormat(locale).formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".";

/** Translate a decimal separator, never grouping or a floating-point value. */
export function normalizeNumberInput(raw: string, locale: string): string {
  const separator = numberInputDecimalSeparator(locale);
  if (separator === "." || !raw.includes(separator)) return raw;
  const candidate = raw.trim().replace(separator, ".");
  // Mixing canonical and localized separators (or repeated separators) stays
  // invalid instead of silently turning a pasted grouped number into a value.
  return !raw.includes(".") && decimalText.test(candidate) ? candidate : raw;
}

export function displayNumberInput(canonical: string, locale: string): string {
  return decimalText.test(canonical) ? canonical.replace(".", numberInputDecimalSeparator(locale)) : canonical;
}
