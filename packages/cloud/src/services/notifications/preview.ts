export const NOTIFICATION_PREVIEW_LIMIT = 200;
const PREVIEW_INPUT_LIMIT = 1_000;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const normalizeNotificationPreview = (value: string): string | undefined => {
  let prefix = value.slice(0, PREVIEW_INPUT_LIMIT);
  const clipped = value.length > prefix.length;
  if (clipped) {
    // A boundary at or before the bound depends on at most one following code point (two UTF-16 units).
    const last = segmenter.segment(value.slice(0, PREVIEW_INPUT_LIMIT + 2)).containing(PREVIEW_INPUT_LIMIT - 1);
    if (last && last.index + last.segment.length > PREVIEW_INPUT_LIMIT) prefix = prefix.slice(0, last.index);
  }
  const text = prefix.replace(/[\s\p{Cc}]+/gu, " ").trim();
  if (!text) return undefined;
  if (!clipped && text.length <= NOTIFICATION_PREVIEW_LIMIT) return text;

  let end = 0;
  for (const { segment, index } of segmenter.segment(text)) {
    if (index + segment.length > NOTIFICATION_PREVIEW_LIMIT - 1) break;
    end = index + segment.length;
  }
  return `${text.slice(0, end).trimEnd()}…`;
};
