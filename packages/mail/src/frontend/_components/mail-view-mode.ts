import { type DateContext, dates } from "@k2b/stdlib";

/** F2: what a person sees in one mailbox on a large screen. "auto" shows columns until a conversation is open. */
export type MailLargeView = "auto" | "columns" | "split";
/** F2 on phones: today's three-line rows, or a denser one-line list. */
export type MailPhoneView = "compact" | "detailed";

export const MAIL_LARGE_VIEWS: readonly MailLargeView[] = ["auto", "columns", "split"];

export type MailLargeLayout = {
  /** How the list draws its rows. */
  rows: "lines" | "columns";
  /** `full` fills the main area, `pane` sits beside the reader, `hidden` gives the reader the full width. */
  list: "full" | "pane" | "hidden";
  reader: boolean;
};

/** The layout for a view choice; it changes only when a conversation opens or closes. */
export const resolveMailLargeLayout = (view: MailLargeView, conversationOpen: boolean): MailLargeLayout => {
  if (view === "split") return { rows: "lines", list: "pane", reader: true };
  if (!conversationOpen) return { rows: "columns", list: "full", reader: false };
  return view === "columns" ? { rows: "columns", list: "hidden", reader: true } : { rows: "lines", list: "pane", reader: true };
};

/** `V` switches between the two views a person sees, starting from what is on screen now. */
export const toggleMailLargeView = (view: MailLargeView, conversationOpen: boolean): MailLargeView =>
  resolveMailLargeLayout(view, conversationOpen).rows === "columns" ? "split" : "columns";

export type MailDayGroup = "today" | "yesterday" | "week" | "earlier";

const dayKey = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

/** Whole days between two calendar dates in one time zone, independent of daylight-saving hours. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Days since the week started: 0 on its first day. `weekStartsOn` is 1 for Monday, 0 for Sunday. */
const daysIntoWeek = (key: string, weekStartsOn: 0 | 1): number => (new Date(`${key}T00:00:00Z`).getUTCDay() - weekStartsOn + 7) % 7;

/** The day group of a mail in the person's time zone: today, yesterday, earlier this week, or earlier. */
export const mailDayGroup = (iso: string, now: Date, timeZone: string, weekStartsOn: 0 | 1 = 1): MailDayGroup => {
  const day = dayKey(new Date(iso), timeZone);
  const today = dayKey(now, timeZone);
  const age = daysBetween(day, today);
  if (age <= 0) return "today";
  if (age === 1) return "yesterday";
  return age <= daysIntoWeek(today, weekStartsOn) ? "week" : "earlier";
};

/** Marks the first item of every day group; the list renders a heading before it. Items arrive newest first. */
export const mailDayGroupStarts = <T extends { latestMessageAt: string }>(
  items: readonly T[],
  now: Date,
  timeZone: string,
  weekStartsOn: 0 | 1 = 1,
): Map<number, MailDayGroup> => {
  const starts = new Map<number, MailDayGroup>();
  let previous: MailDayGroup | null = null;
  items.forEach((item, index) => {
    const group = mailDayGroup(item.latestMessageAt, now, timeZone, weekStartsOn);
    if (group !== previous) starts.set(index, group);
    previous = group;
  });
  return starts;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/**
 * The longest relative times a row can show in this locale: every count of seconds, minutes, and hours, since plural
 * forms differ in length, yesterday, every weekday, and a date in every month. The columns view sizes its time column
 * to the widest of them, measured in the row's own font, so no time is cut off and every row keeps the same column.
 */
export const mailTimeColumnSamples = (dateConfig: DateContext, now: Date): string[] => {
  const base = now.getTime();
  const relative = (time: number, from = base) => dates.formatDateTimeRelative(new Date(time), { ...dateConfig, base: new Date(from) });
  const counts = (length: number, unit: number) => Array.from({ length }, (_, index) => relative(base - (index + 1) * unit));
  const samples = [
    relative(base),
    ...counts(59, 1_000),
    ...counts(59, MINUTE),
    ...counts(23, 60 * MINUTE),
    relative(base - DAY - 60 * MINUTE),
    // Each weekday, three days before its base.
    ...Array.from({ length: 7 }, (_, day) => relative(base + day * DAY, base + (day + 3) * DAY)),
    // Two-digit days of every month, with the year a date shows.
    ...Array.from({ length: 12 }, (_, month) => relative(Date.UTC(now.getUTCFullYear(), month, 28, 12), base + 400 * DAY)),
  ];
  const unique = [...new Set(samples)];
  // Characters are not widths, so every sample near the longest one takes part in the measurement.
  const longest = Math.max(...unique.map((sample) => sample.length));
  return unique.filter((sample) => sample.length >= longest - 3);
};

/** A CSS string of the samples, one per line, for `content` in the time column's sizer. */
export const mailTimeColumnSizer = (samples: readonly string[]): string =>
  `"${samples.map((sample) => sample.replace(/["\\]/gu, "\\$&").replace(/\n/gu, " ")).join("\\A ")}"`;
