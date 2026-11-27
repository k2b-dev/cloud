import type { AttachmentFigures } from "../../../service/notebook-figures";

const dayOf = (at: Date, timeZone: string) => {
  // en-CA writes the calendar day as YYYY-MM-DD in the given time zone
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(at)
    .split("-")
    .map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / 86_400_000;
};

/**
 * The attachment figures after one file is gone, without asking the server again: one fewer file and its bytes, and,
 * when it was uploaded in the window, one fewer upload on its day. The days are the reader's, as the server counted
 * them (`timeZone`), and the window ends on the day of `now`.
 */
export const withoutAttachment = (
  figures: AttachmentFigures,
  attachment: { sizeBytes: number; createdAt: string },
  now: string,
  timeZone: string,
): AttachmentFigures => {
  const back = dayOf(new Date(now), timeZone) - dayOf(new Date(attachment.createdAt), timeZone);
  const index = figures.days.length - 1 - back;
  const inWindow = back >= 0 && index >= 0 && (figures.days[index] ?? 0) > 0;
  return {
    days: inWindow ? figures.days.map((value, at) => (at === index ? value - 1 : value)) : figures.days,
    count: Math.max(0, figures.count - 1),
    bytes: Math.max(0, figures.bytes - attachment.sizeBytes),
    added: inWindow ? Math.max(0, figures.added - 1) : figures.added,
  };
};
