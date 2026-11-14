import { truncateUtf8 } from "../lib/utf8";

const REPLY_PREFIX = /^(?:\[[^\]\r\n]+\]\s*)*(?:re|fw|fwd|aw|wg|rv|sv|antw)(?:\[\d+\])?\s*:\s*/i;
const LEADING_TAG = /^(?:\[[^\]\r\n]+\]\s*)+/;

/** Remove only reply/forward prefixes, retaining the subject's identifying tags and spelling. */
export const stripMailSubjectPrefixes = (subject: string): string => {
  let value = subject.trim();
  for (;;) {
    const match = value.match(REPLY_PREFIX);
    if (!match) return value;
    const tags = match[0].match(LEADING_TAG)?.[0] ?? "";
    value = `${tags}${value.slice(match[0].length)}`.trim();
  }
};

const collapseSubject = (subject: string): string => subject.trim().toLowerCase().replace(/\s+/g, " ");

export const normalizeMailSubject = (subject: string): string => {
  let value = collapseSubject(subject);
  const identifyingTags: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const leadingTags = value.match(LEADING_TAG)?.[0] ?? "";
    identifyingTags.push(...(leadingTags.match(/\[[^\]\r\n]*[\d#][^\]\r\n]*\]/g) ?? []));
    const next = value.slice(leadingTags.length).replace(REPLY_PREFIX, "").trim();
    if (next === value) break;
    value = next;
  }
  value = [...identifyingTags, value].filter(Boolean).join(" ");
  // Bytes, not characters: a Postgres B-tree entry holds at most 2704 bytes, and
  // message_contents_subject_thread_idx indexes this value.
  return truncateUtf8(value, 2_000);
};

/** Whether the subject starts with a reply or forward prefix that `normalizeMailSubject` removes. */
export const hasReplySubjectPrefix = (subject: string): boolean => REPLY_PREFIX.test(collapseSubject(subject));

/** `hasReplySubjectPrefix` as a PostgreSQL regular expression for a trimmed subject, matched with `~*`. */
export const REPLY_SUBJECT_PREFIX_PATTERN = REPLY_PREFIX.source;
