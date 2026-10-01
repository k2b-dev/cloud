import { truncateUtf8 } from "../lib/utf8";

export const normalizeMailSubject = (subject: string): string => {
  let value = subject.trim().toLowerCase().replace(/\s+/g, " ");
  for (let index = 0; index < 8; index += 1) {
    const next = value.replace(/^(?:(?:re|fw|fwd|aw|wg)(?:\[\d+\])?:\s*)/i, "").trim();
    if (next === value) break;
    value = next;
  }
  // Bytes, not characters: a Postgres B-tree entry holds at most 2704 bytes, and
  // message_contents_subject_thread_idx indexes this value.
  return truncateUtf8(value, 2_000);
};
