import { truncateUtf8 } from "../lib/utf8";

const REPLY_PREFIX = /^(?:(?:re|fw|fwd|aw|wg)(?:\[\d+\])?:\s*)/i;

const collapseSubject = (subject: string): string => subject.trim().toLowerCase().replace(/\s+/g, " ");

export const normalizeMailSubject = (subject: string): string => {
  let value = collapseSubject(subject);
  for (let index = 0; index < 8; index += 1) {
    const next = value.replace(REPLY_PREFIX, "").trim();
    if (next === value) break;
    value = next;
  }
  // Bytes, not characters: a Postgres B-tree entry holds at most 2704 bytes, and
  // message_contents_subject_thread_idx indexes this value.
  return truncateUtf8(value, 2_000);
};

/** Whether the subject starts with a reply or forward prefix that `normalizeMailSubject` removes. */
export const hasReplySubjectPrefix = (subject: string): boolean => REPLY_PREFIX.test(collapseSubject(subject));
