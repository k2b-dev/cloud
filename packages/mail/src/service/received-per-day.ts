import { sql } from "@k2b/cloud";
import { type MailboxAccess, messageVisibleTo } from "./access";
import { isSentDraftsOrJunkFolder } from "./follow-up-scope";

/** The days a reader's year of mail spans: 53 weeks, whatever day a week starts on (53 × 7 days). */
export const RECEIVED_PER_DAY_DAYS = 371;

/** The mails a mailbox received per day up to `today`, in the time zone of the person who reads it. */
export type MailReceivedPerDay = {
  /** The last day, as a date key in that time zone ("2026-11-27"). */
  today: string;
  /** One entry per day with mail, oldest first; at most `RECEIVED_PER_DAY_DAYS`. */
  days: { date: string; count: number }[];
};

/** The date key of `now` in `timeZone`. */
const dateIn = (now: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/**
 * The mails a mailbox received per day over the last 371 days, as one bounded aggregate: one statement, at most one
 * row per day. A received mail is filed in the mailbox and in none of its Sent, Drafts or Junk folders. It counts by
 * its date in `timeZone`, and only when `access` may see it, by the same rule as the list (`messageVisibleTo`).
 * Loaded with the page and with a mailbox switch only, never per message or per navigation (DATA-13).
 */
export const loadReceivedPerDay = async (params: {
  mailboxId: string;
  access: MailboxAccess;
  timeZone: string;
  now?: Date;
}): Promise<MailReceivedPerDay> => {
  const today = dateIn(params.now ?? new Date(), params.timeZone);
  const rows = await sql<{ day: string; count: number }[]>`
    SELECT to_char(mc.internal_date AT TIME ZONE ${params.timeZone}, 'YYYY-MM-DD') AS day, count(*)::int AS count
    FROM mail.message_contents mc
    WHERE mc.mailbox_id = ${params.mailboxId}::uuid
      AND mc.internal_date >= ((${today}::date - ${RECEIVED_PER_DAY_DAYS - 1}::int)::timestamp AT TIME ZONE ${params.timeZone})
      AND mc.internal_date < ((${today}::date + 1)::timestamp AT TIME ZONE ${params.timeZone})
      AND EXISTS (
        SELECT 1 FROM mail.message_placements filed WHERE filed.message_id = mc.id AND filed.deleted_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM mail.message_placements own
        WHERE own.message_id = mc.id
          AND own.deleted_at IS NULL
          AND ${isSentDraftsOrJunkFolder(sql`own.folder_id`)}
      )
      AND ${messageVisibleTo(params.access, sql`mc.id`)}
    GROUP BY day
    ORDER BY day
  `;
  return { today, days: rows.map((row) => ({ date: row.day, count: row.count })) };
};
