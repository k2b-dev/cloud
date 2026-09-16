/** Supported DATEADD input/result range, shared by preview and SQL. */
export const DATEADD_RANGE = {
  minYear: 1000,
  maxYear: 9999,
  minDate: "1000-01-01",
  maxDate: "9999-12-31",
} as const;

// Minutes are the smallest supported unit. No valid shift in any unit can
// exceed the total number of whole minutes in the supported calendar range.
export const MAX_DATEADD_AMOUNT = Math.floor(
  (Date.parse(`${DATEADD_RANGE.maxDate}T23:59:59Z`) - Date.parse(`${DATEADD_RANGE.minDate}T00:00:00Z`)) / 60_000,
);
