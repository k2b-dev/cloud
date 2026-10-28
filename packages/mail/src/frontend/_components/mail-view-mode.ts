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
