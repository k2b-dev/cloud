import { redis, sql } from "@k2b/cloud";
import { z } from "zod";
import type { MailboxAccess } from "./access";
import { messageVisibleTo } from "./access";
import { isDraftsOrJunkFolder } from "./follow-up-scope";

/** The days a reader's year of mail spans: 53 weeks, whatever day a week starts on (53 × 7 days). */
export const RECEIVED_PER_DAY_DAYS = 371;

/**
 * How long one reader's year of mail is reused. The picture counts whole days and its key holds today, so it never
 * shows yesterday as today; within a day only today's cell and the sum can lag, by the mail of the last five minutes.
 * Reloads and mailbox switches back and forth within that time cost no statement.
 */
export const RECEIVED_PER_DAY_TTL_MS = 5 * 60_000;
const CACHE_COMMAND_MS = 100; // as the view-count cache: a slow cache never holds a Mail page hostage

/** The mails of a mailbox per day up to `today`, in the time zone of the person who reads it. */
export type MailReceivedPerDay = {
  /** The last day, as a date key in that time zone ("2026-11-27"). */
  today: string;
  /** One entry per day with mail, oldest first; at most `RECEIVED_PER_DAY_DAYS`. */
  days: { date: string; incoming: number; sent: number }[];
};

const snapshotSchema = z.object({
  today: z.string(),
  days: z.array(z.object({ date: z.string(), incoming: z.number().int().nonnegative(), sent: z.number().int().nonnegative() })),
});

/** The date key of `now` in `timeZone`. */
const dateIn = (now: Date, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

const command = async (name: string, args: string[]): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      redis.send(name, args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Mail received-per-day cache unavailable")), CACHE_COMMAND_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * The year of mail of one mailbox for one reader, in one statement: per day over the last 371 days, the mails that
 * came in and the mails it sent. A mail is sent when its From is one of the mailbox's sender identities, as in Mail's
 * timeline and list, wherever it lies now (Sent, Archive or Trash); every other mail came in, also one in Trash. A mail
 * counts while it is filed in the mailbox and in none of its Drafts or Junk folders, by its date in `timeZone`, and
 * only when `access` may see it, by the list's rule (`messageVisibleTo`).
 */
const queryReceivedPerDay = async (params: {
  mailboxId: string;
  access: MailboxAccess;
  timeZone: string;
  today: string;
}): Promise<MailReceivedPerDay> => {
  const rows = await sql<{ day: string; incoming: number; sent: number }[]>`
    SELECT day, count(*) FILTER (WHERE NOT outbound)::int AS incoming, count(*) FILTER (WHERE outbound)::int AS sent
    FROM (
      SELECT
        to_char(mc.internal_date AT TIME ZONE ${params.timeZone}, 'YYYY-MM-DD') AS day,
        EXISTS (
          SELECT 1
          FROM mail.message_addresses sender
          JOIN mail.sender_identities identity
            ON identity.mailbox_id = mc.mailbox_id
           AND lower(identity.from_address) = sender.normalized_email
          WHERE sender.message_id = mc.id AND sender.role = 'from'
        ) AS outbound
      FROM mail.message_contents mc
      WHERE mc.mailbox_id = ${params.mailboxId}::uuid
        AND mc.internal_date >= ((${params.today}::date - ${RECEIVED_PER_DAY_DAYS - 1}::int)::timestamp AT TIME ZONE ${params.timeZone})
        AND mc.internal_date < ((${params.today}::date + 1)::timestamp AT TIME ZONE ${params.timeZone})
        AND EXISTS (
          SELECT 1 FROM mail.message_placements filed WHERE filed.message_id = mc.id AND filed.deleted_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM mail.message_placements unwanted
          WHERE unwanted.message_id = mc.id
            AND unwanted.deleted_at IS NULL
            AND ${isDraftsOrJunkFolder(sql`unwanted.folder_id`)}
        )
        AND ${messageVisibleTo(params.access, sql`mc.id`)}
    ) classified
    GROUP BY day
    ORDER BY day
  `;
  return { today: params.today, days: rows.map((row) => ({ date: row.day, incoming: row.incoming, sent: row.sent })) };
};

/**
 * The year of mail of a mailbox, for the v2 reader while none is open. One bounded aggregate (one statement, at most
 * one row per day), reused per mailbox, reader, time zone and day for `RECEIVED_PER_DAY_TTL_MS`. Without the cache it
 * still answers, from the database. Loaded with the page and with a mailbox switch only, never per message or per
 * navigation inside a mailbox (DATA-13).
 */
export const loadReceivedPerDay = async (params: {
  mailboxId: string;
  access: MailboxAccess;
  timeZone: string;
  now?: Date;
}): Promise<MailReceivedPerDay> => {
  const today = dateIn(params.now ?? new Date(), params.timeZone);
  // Mailbox ids are random UUIDs, so a key never meets another database's mailbox.
  const reader = params.access.scope === "mailbox" ? "mailbox" : `assigned:${params.access.userId ?? params.access.serviceAccountId}`;
  const key = `mail:received-per-day:v1:${params.mailboxId}:${reader}:${params.timeZone}:${today}`;
  try {
    const raw = await command("GET", [key]);
    const cached = typeof raw === "string" ? snapshotSchema.safeParse(JSON.parse(raw)) : null;
    if (cached?.success && cached.data.today === today) return cached.data;
  } catch {
    // no cache: count from the database
  }
  const fresh = await queryReceivedPerDay({ ...params, today });
  await command("SET", [key, JSON.stringify(fresh), "PX", String(RECEIVED_PER_DAY_TTL_MS)]).catch(() => undefined);
  return fresh;
};
