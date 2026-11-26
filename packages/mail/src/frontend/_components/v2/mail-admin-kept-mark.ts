import type { MarkProps } from "@k2b/ui/v2";

/** Mail's colour (its app accent), the colour of a kept conversation wherever administration shows one. */
const MAIL_COLOR = "#0f766e";

/**
 * The mark of a kept conversation in the list, on the phone and in its record's head. A conversation whose mailbox is
 * gone stays neutral: only Cloud's kept copy is left of it.
 */
export const keptMark = (orphaned: boolean): MarkProps => (orphaned ? { icon: "lock" } : { icon: "lock", color: MAIL_COLOR });
