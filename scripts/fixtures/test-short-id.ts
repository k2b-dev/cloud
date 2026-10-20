/** Fixture IDs live outside readableId()'s alphabet, which never emits `o` or `O`. */
export const TEST_SHORT_ID_MARK = "o";
let counter = Date.now();

/**
 * Raw fixture inserts bypass the services' collision retry. Use `o` plus a
 * padded base36 counter to keep fixtures unique and apart from service IDs.
 * The time seed puts a later process beyond an earlier one's IDs only if it
 * issued fewer IDs than the milliseconds it ran; a faster issuer can reach
 * into the next process's range. Each checkout has its own test database and
 * integration files run in separate processes, sequentially. The counter
 * wraps after 36 ** (length - 1) calls at the same length.
 */
export const testShortId = (length = 6): string => {
  if (length < 2) throw new Error("Fixture short IDs need at least two characters");
  counter++;
  return `${TEST_SHORT_ID_MARK}${(counter % 36 ** (length - 1)).toString(36).padStart(length - 1, "0")}`;
};
