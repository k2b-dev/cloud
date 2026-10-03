import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { MAX_MAILBOX_PREFERENCES } from "../contracts";
import { requireMailboxPermission } from "./access";
import { capByCredentialScopes, type MailRequestContext, type PersonalPrincipal, personalPrincipal } from "./auth";
import { readableMailboxes } from "./focus";

type SqlClient = typeof sql;
type Preference = "pinned" | "hidden";

/** Internal mailbox IDs, newest first, as the overview orders them. */
export type MailboxPreferences = { pinnedMailboxIds: string[]; hiddenMailboxIds: string[] };
export type MailboxPreferenceChange = { pinned?: boolean; hidden?: boolean };

const principalMatches = (principal: PersonalPrincipal) =>
  principal.kind === "user"
    ? sql`preference.user_id = ${principal.id}::uuid`
    : sql`preference.user_id IS NULL AND preference.service_account_id = ${principal.id}::uuid`;
const principalColumns = (principal: PersonalPrincipal) => ({
  userId: principal.kind === "user" ? principal.id : null,
  serviceAccountId: principal.kind === "service_account" ? principal.id : null,
});
const isSet = (preference: Preference) =>
  preference === "pinned" ? sql`preference.pinned_at IS NOT NULL` : sql`preference.hidden_at IS NOT NULL`;

/** One principal's changes run one after another, so two devices adding at once stay within the limit. */
const lockPrincipal = (tx: SqlClient, principal: PersonalPrincipal) =>
  tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mail.mailbox-preferences:${principal.kind}:${principal.id}`}, 0))`;

/**
 * Rows of mailboxes the principal can no longer read stay, so a grant that comes back restores
 * them, but they never count: not in the lists, not against the limit.
 */
const countReadable = async (tx: SqlClient, context: MailRequestContext, principal: PersonalPrincipal) => {
  const [row] = await tx<{ pinned: number; hidden: number }[]>`
    SELECT
      count(*) FILTER (WHERE ${isSet("pinned")})::int AS pinned,
      count(*) FILTER (WHERE ${isSet("hidden")})::int AS hidden
    FROM mail.personal_mailbox_preferences preference
    JOIN (${readableMailboxes(context)}) readable ON readable.mailbox_id = preference.mailbox_id
    WHERE ${principalMatches(principal)}
  `;
  return { pinned: row?.pinned ?? 0, hidden: row?.hidden ?? 0 };
};

const limitReached = (preference: Preference) =>
  fail(
    err.badInput(
      preference === "pinned"
        ? `At most ${MAX_MAILBOX_PREFERENCES} mailboxes can be pinned`
        : `At most ${MAX_MAILBOX_PREFERENCES} mailboxes can be hidden`,
    ),
  );

/** The caller's pinned and hidden mailboxes among those they can read, newest first. */
export const listMailboxPreferences = async (context: MailRequestContext): Promise<MailboxPreferences> => {
  if (capByCredentialScopes(context, "read") !== "read") return { pinnedMailboxIds: [], hiddenMailboxIds: [] };
  const rows = await sql<{ mailbox_id: string; pinned_at: Date | null; hidden_at: Date | null }[]>`
    SELECT preference.mailbox_id, preference.pinned_at, preference.hidden_at
    FROM mail.personal_mailbox_preferences preference
    JOIN (${readableMailboxes(context)}) readable ON readable.mailbox_id = preference.mailbox_id
    WHERE ${principalMatches(personalPrincipal(context))}
  `;
  const newest = (column: "pinned_at" | "hidden_at") =>
    rows
      .filter((row) => row[column] !== null)
      .sort((left, right) => right[column]!.getTime() - left[column]!.getTime() || left.mailbox_id.localeCompare(right.mailbox_id))
      .slice(0, MAX_MAILBOX_PREFERENCES)
      .map((row) => row.mailbox_id);
  return { pinnedMailboxIds: newest("pinned_at"), hiddenMailboxIds: newest("hidden_at") };
};

/**
 * Pins, unpins, hides, or shows one mailbox for the caller, a person or a service account. A change
 * leaves the other preference as it is, so two devices that change different flags never undo each other.
 */
export const setMailboxPreference = async (
  context: MailRequestContext,
  mailboxId: string,
  change: MailboxPreferenceChange,
): Promise<Result<{ pinned: boolean; hidden: boolean }>> => {
  const allowed = await requireMailboxPermission(context, mailboxId, "read");
  if (!allowed.ok) return allowed;
  const principal = personalPrincipal(context);
  const { userId, serviceAccountId } = principalColumns(principal);
  const pinned = change.pinned ?? null;
  const hidden = change.hidden ?? null;
  return sql.begin(async (tx): Promise<Result<{ pinned: boolean; hidden: boolean }>> => {
    await lockPrincipal(tx, principal);
    const [current] = await tx<{ pinned: boolean; hidden: boolean }[]>`
      SELECT ${isSet("pinned")} AS pinned, ${isSet("hidden")} AS hidden
      FROM mail.personal_mailbox_preferences preference
      WHERE ${principalMatches(principal)} AND preference.mailbox_id = ${mailboxId}::uuid
    `;
    const adds = (["pinned", "hidden"] as const).filter((preference) => change[preference] === true && !current?.[preference]);
    if (adds.length > 0) {
      const counts = await countReadable(tx, context, principal);
      const full = adds.find((preference) => counts[preference] >= MAX_MAILBOX_PREFERENCES);
      if (full) return limitReached(full);
    }
    const [stored] = await tx<{ pinned_at: Date | null; hidden_at: Date | null }[]>`
      INSERT INTO mail.personal_mailbox_preferences AS preference (mailbox_id, user_id, service_account_id, pinned_at, hidden_at)
      VALUES (
        ${mailboxId}::uuid, ${userId}::uuid, ${serviceAccountId}::uuid,
        CASE WHEN ${pinned}::boolean THEN now() END,
        CASE WHEN ${hidden}::boolean THEN now() END
      )
      ON CONFLICT (user_id, service_account_id, mailbox_id) DO UPDATE SET
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
    if (!stored?.pinned_at && !stored?.hidden_at) {
      await tx`
        DELETE FROM mail.personal_mailbox_preferences preference
        WHERE ${principalMatches(principal)} AND preference.mailbox_id = ${mailboxId}::uuid
      `;
    }
    return ok({ pinned: stored?.pinned_at != null, hidden: stored?.hidden_at != null });
  });
};

/**
 * Adds the pins and hidden mailboxes one browser kept in its cookie before they were stored per
 * person. It takes the public mailbox IDs the cookie holds, newest first, keeps only mailboxes the
 * caller can read, and keeps what is already stored, so a second browser adds its own without
 * undoing the first. Entries past the limit are left out, oldest first.
 */
export const importBrowserMailboxPreferences = async (
  context: MailRequestContext,
  browser: { pinnedMailboxIds: string[]; hiddenMailboxIds: string[] },
): Promise<void> => {
  const shortIds = [...new Set([...browser.pinnedMailboxIds, ...browser.hiddenMailboxIds])];
  if (shortIds.length === 0 || capByCredentialScopes(context, "read") !== "read") return;
  const principal = personalPrincipal(context);
  const { userId, serviceAccountId } = principalColumns(principal);
  await sql.begin(async (tx) => {
    await lockPrincipal(tx, principal);
    const rows = await tx<{ short_id: string; mailbox_id: string; pinned: boolean; hidden: boolean }[]>`
      SELECT
        mailbox.short_id,
        mailbox.id AS mailbox_id,
        ${isSet("pinned")} AS pinned,
        ${isSet("hidden")} AS hidden
      FROM mail.mailboxes mailbox
      JOIN (${readableMailboxes(context)}) readable ON readable.mailbox_id = mailbox.id
      LEFT JOIN mail.personal_mailbox_preferences preference
        ON preference.mailbox_id = mailbox.id AND ${principalMatches(principal)}
      WHERE mailbox.short_id = ANY(${toPgTextArray(shortIds)}::text[])
    `;
    const byShortId = new Map(rows.map((row) => [row.short_id, row]));
    const counts = await countReadable(tx, context, principal);
    const additions = (preference: Preference, ids: string[]) =>
      ids
        .flatMap((id) => {
          const row = byShortId.get(id);
          return row && !row[preference] ? [row.mailbox_id] : [];
        })
        .slice(0, Math.max(MAX_MAILBOX_PREFERENCES - counts[preference], 0));
    // Older entries get earlier timestamps, so the stored order matches the browser's.
    const pinned = additions("pinned", browser.pinnedMailboxIds);
    if (pinned.length > 0) {
      await tx`
        INSERT INTO mail.personal_mailbox_preferences AS preference (mailbox_id, user_id, service_account_id, pinned_at)
        SELECT item.mailbox_id, ${userId}::uuid, ${serviceAccountId}::uuid, now() - item.position * interval '1 millisecond'
        FROM unnest(${toPgUuidArray(pinned)}::uuid[]) WITH ORDINALITY AS item(mailbox_id, position)
        ON CONFLICT (user_id, service_account_id, mailbox_id) DO UPDATE SET pinned_at = COALESCE(preference.pinned_at, EXCLUDED.pinned_at)
      `;
    }
    const hidden = additions("hidden", browser.hiddenMailboxIds);
    if (hidden.length > 0) {
      await tx`
        INSERT INTO mail.personal_mailbox_preferences AS preference (mailbox_id, user_id, service_account_id, hidden_at)
        SELECT item.mailbox_id, ${userId}::uuid, ${serviceAccountId}::uuid, now() - item.position * interval '1 millisecond'
        FROM unnest(${toPgUuidArray(hidden)}::uuid[]) WITH ORDINALITY AS item(mailbox_id, position)
        ON CONFLICT (user_id, service_account_id, mailbox_id) DO UPDATE SET hidden_at = COALESCE(preference.hidden_at, EXCLUDED.hidden_at)
      `;
    }
  });
};
