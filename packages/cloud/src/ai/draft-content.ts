import { type AiMessageQuote, aiQuoteModelText } from "./quote-markers";
import { aiResourceMarker } from "./resource-markers";
import type { AiDraftContentPart } from "./types";

export const aiDraftPartLabel = (part: AiDraftContentPart): string =>
  part.type === "text" || part.type === "quote"
    ? part.text
    : part.type === "resource"
      ? (part.title ?? part.ref.id)
      : part.type === "project-file"
        ? part.path
        : part.path.split("/").at(-1) || part.path;

export const aiDraftText = (content: readonly AiDraftContentPart[]) =>
  content.map((part) => (part.type === "text" || (part.type !== "quote" && part.inline) ? aiDraftPartLabel(part) : "")).join("");

/** Queue text edits preserve untouched inline identities and ordinary attachments. */
export function editAiDraftText(content: readonly AiDraftContentPart[], text: string): AiDraftContentPart[] {
  const before = aiDraftText(content);
  let start = 0,
    oldEnd = before.length,
    newEnd = text.length;
  while (start < oldEnd && start < newEnd && before[start] === text[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === text[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  let position = 0;
  const retained = content.flatMap((part) => {
    if (part.type === "text") {
      position += part.text.length;
      return [];
    }
    if (part.type === "quote" || !part.inline) return [];
    const from = position;
    position += aiDraftPartLabel(part).length;
    if (position <= start) return [{ from, end: position, part }];
    if (from >= oldEnd) return [{ from: from + newEnd - oldEnd, end: position + newEnd - oldEnd, part }];
    return [];
  });
  const result: AiDraftContentPart[] = [];
  let offset = 0;
  for (const item of retained) {
    if (item.from > offset) result.push({ type: "text", text: text.slice(offset, item.from) });
    result.push(item.part);
    offset = item.end;
  }
  if (offset < text.length) result.push({ type: "text", text: text.slice(offset) });
  result.push(...content.filter((part) => part.type !== "text" && (part.type === "quote" || !part.inline)));
  return result;
}

/** The text a draft part sends to the model, for the parts that travel as text: a project file or a Cloud item. */
export const aiDraftPartTurnText = (part: Extract<AiDraftContentPart, { type: "resource" | "project-file" }>): string =>
  part.type === "project-file"
    ? `Project file: ${part.path}`
    : aiResourceMarker({ ref: part.ref, title: part.title, icon: part.icon, href: part.href });

/**
 * A draft's content as the parts a turn sends: text as typed, files as attachments, Cloud items and project files as
 * text, and each quote as the text Cloud writes for the checked quote at the same place, so the model reads it there.
 */
export const aiDraftTurnContent = (content: readonly AiDraftContentPart[], quotes: readonly AiMessageQuote[]) => {
  let quote = 0;
  return content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    if (part.type === "file") return { type: "attachment" as const, path: part.path, mediaType: part.mediaType, size: part.size };
    if (part.type === "quote") return { type: "text" as const, text: aiQuoteModelText(quotes[quote++]!) };
    return { type: "text" as const, text: aiDraftPartTurnText(part) };
  });
};

/** The quotes of a draft, in their order. */
export const aiDraftQuotes = (content: readonly AiDraftContentPart[]) =>
  content.flatMap((part) => (part.type === "quote" ? [{ messageId: part.messageId, text: part.text }] : []));
