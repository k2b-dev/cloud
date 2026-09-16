import type { ChatMention } from "./types";

export type ChatCommandQuery = { start: number; end: number; query: string };

/** Only the token at the caret; URLs, paths and inline/fenced code are ordinary text. */
export function chatCommandQuery(text: string, caret: number, selectionEnd = caret): ChatCommandQuery | null {
  if (caret !== selectionEnd) return null;
  const before = text.slice(0, caret);
  if ((before.match(/`/g)?.length ?? 0) % 2) return null;
  const match = /(?:^|[\s(])\/([^\n/`]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, end: caret, query: match[1]! };
}

/** An edit inside a mention removes its identity; edits around it shift the range. */
export function reconcileChatMentions(before: string, after: string, mentions: readonly ChatMention[]): ChatMention[] {
  if (before === after) return [...mentions];
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return mentions.flatMap(mention => {
    if (mention.end <= start) return [mention];
    if (mention.start >= oldEnd) return [{ ...mention, start: mention.start + newEnd - oldEnd, end: mention.end + newEnd - oldEnd }];
    return [];
  });
}

export function chatMentionSegments(text: string, mentions: readonly ChatMention[]) {
  const segments: { text: string; mention?: ChatMention }[] = [];
  let offset = 0;
  for (const mention of [...mentions].sort((a,b) => a.start - b.start)) {
    if (mention.start < offset || mention.end > text.length || mention.start >= mention.end) continue;
    segments.push({ text: text.slice(offset, mention.start) });
    segments.push({ text: text.slice(mention.start, mention.end), mention });
    offset = mention.end;
  }
  segments.push({ text: text.slice(offset) });
  return segments;
}
