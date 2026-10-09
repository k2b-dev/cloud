export const NOTIFICATION_PREVIEW_LIMIT = 200;
const PREVIEW_INPUT_LIMIT = 1_000;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export const normalizeNotificationPreview = (value: string): string | undefined => {
  let prefix = value.slice(0, PREVIEW_INPUT_LIMIT);
  const clipped = value.length > prefix.length;
  if (clipped) {
    // The final grapheme may continue beyond the bounded prefix. Omit it.
    const last = segmenter.segment(prefix).containing(prefix.length - 1);
    if (last) prefix = prefix.slice(0, last.index);
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
