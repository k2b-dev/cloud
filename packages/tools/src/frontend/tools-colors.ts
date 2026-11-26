/**
 * The data colours of Tools: one colour per kind of thing (a webhook endpoint, an image, an HTTP method), the same in
 * every list, chip and detail. v2 draws a symbol in its data colour on the light and the dark surface alike, so each
 * colour is a middle tone that keeps 3:1 against both (WCAG 1.4.11, non-text contrast); `tools-colors.test.ts` holds
 * every entry to it.
 */
export const toolColors = {
  /** A webhook endpoint, where requests arrive. */
  endpoint: "#0d9488",
  /** A photo or image file. */
  image: "#0891b2",
} as const;

/** The colour of each HTTP method in the webhook tester. */
export const methodColors: Readonly<Record<string, string>> = {
  GET: "#2563eb",
  POST: "#16a34a",
  PUT: "#d97706",
  PATCH: "#7c3aed",
  DELETE: "#e11d48",
};
