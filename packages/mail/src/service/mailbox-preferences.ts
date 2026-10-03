import { toPgTextArray } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { requireMailboxPermission } from "./access";
import { type MailRequestContext, userBackedActor } from "./auth";

type SqlClient = typeof sql;

/** Internal mailbox IDs, newest first, as the overview orders them. */
export type MailboxPreferences = { pinnedMailboxIds: string[]; hiddenMailboxIds: string[] };
export type MailboxPreferenceChange = { pinned?: boolean; hidden?: boolean };

/**
 * A person's pinned and hidden mailboxes. Rows of mailboxes the person can no longer read
 * stay harmless: the overview shows only mailboxes it lists, and Focus ignores them.
 */
export const listMailboxPreferences = async (userId: string, db: SqlClient = sql): Promise<MailboxPreferences> => {
  const rows = await db<{ mailbox_id: string; pinned_at: Date | null; hidden_at: Date | null }[]>`
    SELECT mailbox_id, pinned_at, hidden_at
    FROM mail.user_mailbox_preferences
    WHERE user_id = ${userId}::uuid
  `;
  const newest = (column: "pinned_at" | "hidden_at") =>
    rows
      .filter((row) => row[column] !== null)
      .sort((left, right) => right[column]!.getTime() - left[column]!.getTime() || left.mailbox_id.localeCompare(right.mailbox_id))
      .map((row) => row.mailbox_id);
  return { pinnedMailboxIds: newest("pinned_at"), hiddenMailboxIds: newest("hidden_at") };
};

/**
 * Pins, unpins, hides, or shows one mailbox for the signed-in person. A change leaves the other
 * preference as it is, so two devices that change different mailboxes or flags never undo each other.
 */
export const setMailboxPreference = async (
  context: MailRequestContext,
  mailboxId: string,
  change: MailboxPreferenceChange,
): Promise<Result<{ pinned: boolean; hidden: boolean }>> => {
  const user = userBackedActor(context);
  if (!user) return fail(err.forbidden("Only people can pin or hide mailboxes"));
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const pinned = change.pinned ?? null;
  const hidden = change.hidden ?? null;
  const row = await sql.begin(async (tx) => {
    const [stored] = await tx<{ pinned_at: Date | null; hidden_at: Date | null }[]>`
      INSERT INTO mail.user_mailbox_preferences AS preference (user_id, mailbox_id, pinned_at, hidden_at)
      VALUES (
        ${user.id}::uuid, ${mailboxId}::uuid,
        CASE WHEN ${pinned}::boolean THEN now() END,
        CASE WHEN ${hidden}::boolean THEN now() END
      )
      ON CONFLICT (user_id, mailbox_id) DO UPDATE SET
        pinned_at = CASE
          WHEN ${pinned}::boolean IS NULL THEN preference.pinned_at
          WHEN ${pinned}::boolean THEN COALESCE(preference.pinned_at, now())
        END,
        hidden_at = CASE
          WHEN ${hidden}::boolean IS NULL THEN preference.hidden_at
          WHEN ${hidden}::boolean THEN COALESCE(preference.hidden_at, now())
        END
      RETURNING pinned_at, hidden_at
    `;
    await tx`
      DELETE FROM mail.user_mailbox_preferences
      WHERE user_id = ${user.id}::uuid AND mailbox_id = ${mailboxId}::uuid AND pinned_at IS NULL AND hidden_at IS NULL
    `;
    return stored;
  });
  return ok({ pinned: row?.pinned_at != null, hidden: row?.hidden_at != null });
};

/**
 * Adds the pins and hidden mailboxes one browser kept in its cookie before they were stored per
 * person. It takes the public mailbox IDs the cookie holds, newest first, and keeps what is already
 * stored, so a second browser adds its own without undoing the first.
 */
export const importBrowserMailboxPreferences = async (
  userId: string,
  browser: { pinnedMailboxIds: string[]; hiddenMailboxIds: string[] },
  db: SqlClient = sql,
): Promise<void> => {
  if (browser.pinnedMailboxIds.length === 0 && browser.hiddenMailboxIds.length === 0) return;
  // Older entries get earlier timestamps, so the stored order matches the browser's.
  await db`
    WITH browser AS (
      SELECT short_id, 'pinned' AS kind, position FROM unnest(${toPgTextArray(browser.pinnedMailboxIds)}::text[]) WITH ORDINALITY AS item(short_id, position)
      UNION ALL
      SELECT short_id, 'hidden' AS kind, position FROM unnest(${toPgTextArray(browser.hiddenMailboxIds)}::text[]) WITH ORDINALITY AS item(short_id, position)
    ),
    imported AS (
      SELECT
        mailbox.id AS mailbox_id,
        min(now() - browser.position * interval '1 millisecond') FILTER (WHERE browser.kind = 'pinned') AS pinned_at,
        min(now() - browser.position * interval '1 millisecond') FILTER (WHERE browser.kind = 'hidden') AS hidden_at
      FROM browser
      JOIN mail.mailboxes mailbox ON mailbox.short_id = browser.short_id
      GROUP BY mailbox.id
    )
    INSERT INTO mail.user_mailbox_preferences AS preference (user_id, mailbox_id, pinned_at, hidden_at)
    SELECT ${userId}::uuid, mailbox_id, pinned_at, hidden_at FROM imported
    ON CONFLICT (user_id, mailbox_id) DO UPDATE SET
      pinned_at = COALESCE(preference.pinned_at, EXCLUDED.pinned_at),
      hidden_at = COALESCE(preference.hidden_at, EXCLUDED.hidden_at)
  `;
};
