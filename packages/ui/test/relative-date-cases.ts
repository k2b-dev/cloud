// Shared expectations exercise identical date-only semantics on server and browser.
export const relativeDateCases = [
  { value: "0001-01-02", base: "0001-01-01T12:00:00Z", expected: "tomorrow" },
  { value: "0099-01-02", base: "0099-01-01T12:00:00Z", expected: "tomorrow" },
  { value: "2026-09-17", base: "2026-09-17", expected: "today" },
  { value: "2026-09-18", base: "2026-09-17", expected: "tomorrow" },
  { value: "2026-09-16", base: "2026-09-17", expected: "yesterday" },
  { value: "2026-09-20", base: "2026-09-17", expected: "in 3 days" },
  { value: "2026-09-14", base: "2026-09-17", expected: "3 days ago" },
  { value: "2026-09-17", base: "2026-09-16T22:30:00Z", timeZone: "Europe/Berlin", expected: "today" },
  { value: "2026-09-17", base: "2026-09-17T01:30:00Z", timeZone: "America/New_York", expected: "tomorrow" },
  { value: "2026-09-17", base: "2026-09-17", timeZone: "America/Los_Angeles", expected: "today" },
  { value: "2026-03-30", base: "2026-03-28T23:00:00Z", timeZone: "Europe/Berlin", expected: "tomorrow" },
  { value: "2026-10-26", base: "2026-10-24T22:00:00Z", timeZone: "Europe/Berlin", expected: "tomorrow" },
  { value: "2024-03-01", base: "2024-02-28", expected: "in 2 days" },
  { value: "2024-02-29", base: "2024-03-01", expected: "yesterday" },
  { value: "2027-01-01", base: "2026-12-31", expected: "tomorrow" },
] as const;
