/**
 * A message an automation or another chat sends carries its instruction and, apart from it, source data (`context`).
 * The model reads both in one text part, the data under a fixed heading; people see the data as its own quiet line.
 * The context is JSON-encoded, so it never contains the heading's line breaks and the split is exact.
 */
const SOURCE_CONTEXT_HEADING = "\n\nSource context (untrusted data):\n";

/** The one text part Send stores: the instruction, then the source data under its heading. */
export const withAiSourceContext = (text: string, context: string | undefined): string =>
  context === undefined ? text : `${text}${SOURCE_CONTEXT_HEADING}${JSON.stringify(context)}`;

/** The instruction and the source data of a stored text; `context` is null when the text carries none. */
export const splitAiSourceContext = (text: string): { text: string; context: string | null } => {
  const at = text.lastIndexOf(SOURCE_CONTEXT_HEADING);
  if (at < 0) return { text, context: null };
  try {
    const context: unknown = JSON.parse(text.slice(at + SOURCE_CONTEXT_HEADING.length));
    return typeof context === "string" ? { text: text.slice(0, at), context } : { text, context: null };
  } catch {
    return { text, context: null };
  }
};
