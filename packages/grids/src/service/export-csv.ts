export const csvTextNeedsProtection = (value: string): boolean => /^[\t\r\n ]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value);

/** RFC 4180 quoting, with spreadsheet-safe text by default. Numeric callers
 * may disable text protection only after validating the cell's numeric type. */
export const csvQuote = (value: string, delimiter = ",", protectText = true): string => {
  const safe = protectText && csvTextNeedsProtection(value) ? `'${value}` : value;
  return safe.includes(delimiter) || /[\r\n"]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
