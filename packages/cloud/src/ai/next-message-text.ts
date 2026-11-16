/**
 * The shortest suggestion worth showing: below six characters a "next message" is a word such as "ja", "ok" or "danke",
 * or a model's placeholder such as "null" or "none", and reads as noise in the composer. No suggestion is better than a
 * tiny one (Valentin, 16.11.).
 */
export const AI_NEXT_MESSAGE_MIN_CHARS = 6;
/** The longest suggestion, in Unicode characters. */
export const AI_NEXT_MESSAGE_MAX_CHARS = 200;

/** A model may write the absence it means as the word itself. */
const PLACEHOLDER = /^(?:null|undefined|none|nil)$/i;

/**
 * The text of a suggestion as it may reach the composer, or null: it is a string on one line, not a placeholder for
 * nothing, and between `AI_NEXT_MESSAGE_MIN_CHARS` and `AI_NEXT_MESSAGE_MAX_CHARS` Unicode characters once trimmed. It
 * holds where a suggestion is made and where a stored one is read, so a placeholder saved before never shows either.
 */
export const aiNextMessageText = (value: unknown): string | null => {
  if (typeof value !== "string" || /[\r\n\u2028\u2029\p{Cc}\p{Cf}]/u.test(value)) return null;
  const text = value.trim();
  const length = [...text].length;
  if (PLACEHOLDER.test(text) || length < AI_NEXT_MESSAGE_MIN_CHARS || length > AI_NEXT_MESSAGE_MAX_CHARS) return null;
  return text;
};
