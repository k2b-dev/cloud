import { aiQuoteMarker } from "./quote-markers";
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

/** The text a draft part sends to the model, for the parts that travel as text: a quote, a project file, a Cloud item. */
export const aiDraftPartTurnText = (part: Exclude<AiDraftContentPart, { type: "text" | "file" }>): string =>
  part.type === "quote"
    ? aiQuoteMarker({ from: part.from, text: part.text })
    : part.type === "project-file"
      ? `Project file: ${part.path}`
      : aiResourceMarker({ ref: part.ref, title: part.title, icon: part.icon, href: part.href });
