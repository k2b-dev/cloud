import { audit, coreSettings } from "@k2b/cloud/services";
import { dates, err, fail, type Result, tryCatch, unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { requireMailboxPermission } from "./access";
import { auditActorFromRequest, type MailRequestContext } from "./auth";
import { enqueueMailInvalidation, mailLive } from "./live";

type SqlClient = typeof sql;
type BudgetTransaction = { db?: SqlClient };
const inTransaction = <T>(db: SqlClient | undefined, action: (tx: SqlClient) => Promise<T>) => (db ? action(db) : sql.begin(action));
type ReservationKey = { mailboxId: string; sourceId: string; reservationKey: string };
type SourceBudget = { mailboxId: string; sourceId: string; maxAiCallsPerDay?: number | null };
type Usage = { reserved_calls: string; consumed_calls: string };
type StoredReservation = {
  source_name: string;
  day: string;
  time_zone: string;
  resets_at: Date | string;
  planned_calls: number;
  consumed_calls: number;
  state: "reserved" | "released" | "consumed";
};

export type AiDailyReservation = ReservationKey & {
  sourceName: string;
  plannedMaxCalls: number;
  consumedCalls: number;
  day: string;
  timeZone: string;
  resetsAt: string;
};
export type AiDailyLimit = { scope: "rule" | "mailbox"; limit: number; resetsAt: string };
export type AiDailyAdmission =
  | { status: "reserved" | "consumed"; reservation: AiDailyReservation }
  | ({ status: "limited" } & AiDailyLimit);
export type AiDailySourceStats = {
  aiCallsToday: number;
  reservedAiCalls: number;
  maxAiCallsPerDay: number | null;
  limitedUntil: string | null;
  resetsAt: string;
  timeZone: string;
};

// Settings and individual planned maxima fit the Postgres integer columns.
const validCount = (value: number): boolean => Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
const validLimit = (value: number | null | undefined): boolean => value == null || validCount(value);
const validSourceLimit = (value: number | null | undefined): boolean => value == null || (validCount(value) && value > 0);
const validSource = (params: { sourceId: string }): boolean => params.sourceId.trim().length > 0;
const validKey = (params: ReservationKey): boolean => validSource(params) && params.reservationKey.trim().length > 0;

const calendarDay = (timeZone: string) => {
  const day = dates.instantToZonedInput(new Date(), timeZone).slice(0, 10);
  // Advance the civil date, not the instant: DST days need not last 24 hours.
  const nextDay = new Date(`${day}T12:00:00.000Z`);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return {
    day,
    timeZone,
    resetsAt: dates.zonedDateTimeToInstant(`${nextDay.toISOString().slice(0, 10)}T00:00`, timeZone, { disambiguation: "compatible" }),
  };
};
const mailboxTimeZone = async (): Promise<string> =>
  dates.normalizeTimeZone((await coreSettings.get<string>("app.timezone"))?.trim(), "Europe/Berlin");

/** Every counter writer takes this lock first, including settlement and admin settings. */
const lockMailbox = async (tx: SqlClient, mailboxId: string, includeDeleted = false) => {
  const [mailbox] = await tx<{ ai_calls_per_day: number | null }[]>`
    SELECT ai_calls_per_day FROM mail.mailboxes
    WHERE id = ${mailboxId}::uuid AND (${includeDeleted} OR deleted_at IS NULL) FOR UPDATE
  `;
  if (!mailbox) throw err.notFound("Mailbox");
  return mailbox;
};
const readReservation = async (tx: SqlClient, params: ReservationKey): Promise<StoredReservation | undefined> => {
  const [row] = await tx<StoredReservation[]>`
    SELECT source_name, day::text, time_zone, resets_at, planned_calls, consumed_calls, state
    FROM mail.ai_daily_reservations
    WHERE mailbox_id = ${params.mailboxId}::uuid AND source_id = ${params.sourceId} AND reservation_key = ${params.reservationKey}
  `;
  return row;
};
const mapReservation = (params: ReservationKey, row: StoredReservation): AiDailyReservation => ({
  mailboxId: params.mailboxId,
  sourceId: params.sourceId,
  reservationKey: params.reservationKey,
  sourceName: row.source_name,
  plannedMaxCalls: row.planned_calls,
  consumedCalls: row.consumed_calls,
  day: row.day,
  timeZone: row.time_zone,
  resetsAt: new Date(row.resets_at).toISOString(),
});
const readUsage = async (tx: SqlClient, params: { mailboxId: string; sourceId: string; day: string }) => {
  const [mailbox] = await tx<Usage[]>`
    SELECT reserved_calls::text, consumed_calls::text FROM mail.ai_daily_mailbox_usage
    WHERE mailbox_id = ${params.mailboxId}::uuid AND day = ${params.day}::date
  `;
  const [source] = await tx<Usage[]>`
    SELECT reserved_calls::text, consumed_calls::text FROM mail.ai_daily_source_usage
    WHERE mailbox_id = ${params.mailboxId}::uuid AND source_id = ${params.sourceId} AND day = ${params.day}::date
  `;
  const usage = (row: Usage | undefined) => ({ reserved: BigInt(row?.reserved_calls ?? 0), consumed: BigInt(row?.consumed_calls ?? 0) });
  return { mailbox: usage(mailbox), source: usage(source) };
};

/**
 * Trusted Mail service API: the caller authorizes the mailbox/source and calls this BEFORE any mail effect.
 * Source IDs belong to the caller, not to a workflow table. A stable key identifies one operation across retries.
 * A duplicate reserved/consumed key returns its original reservation even after midnight or a limit change.
 * With db, the caller owns the transaction: lock mailbox before conversation and unwrap failures to roll back.
 */
export const reserveAiDailyBudget = async (
  params: ReservationKey & SourceBudget & BudgetTransaction & { sourceName: string; plannedMaxCalls: number },
): Promise<Result<AiDailyAdmission>> => {
  if (!validKey(params) || !params.sourceName.trim() || !validCount(params.plannedMaxCalls) || !validSourceLimit(params.maxAiCallsPerDay)) {
    return fail(err.badInput("Invalid daily AI reservation"));
  }
  return tryCatch(
    async () => {
      const timeZone = await mailboxTimeZone();
      return inTransaction(params.db, async (tx): Promise<AiDailyAdmission> => {
        const mailbox = await lockMailbox(tx, params.mailboxId);
        const existing = await readReservation(tx, params);
        if (existing && existing.planned_calls !== params.plannedMaxCalls) throw err.conflict("Daily AI reservation maximum changed");
        if (existing && existing.state !== "released") {
          return { status: existing.state, reservation: mapReservation(params, existing) };
        }
        // Calculate after taking the lock, so a waiter crossing midnight reserves the new day.
        const period = calendarDay(timeZone);
        const usage = await readUsage(tx, { ...params, day: period.day });
        const planned = BigInt(params.plannedMaxCalls);
        if (planned > 0n) {
          if (
            params.maxAiCallsPerDay != null &&
            usage.source.consumed + usage.source.reserved + planned > BigInt(params.maxAiCallsPerDay)
          ) {
            return { status: "limited", scope: "rule", limit: params.maxAiCallsPerDay, resetsAt: period.resetsAt };
          }
          if (
            mailbox.ai_calls_per_day !== null &&
            usage.mailbox.consumed + usage.mailbox.reserved + planned > BigInt(mailbox.ai_calls_per_day)
          ) {
            return { status: "limited", scope: "mailbox", limit: mailbox.ai_calls_per_day, resetsAt: period.resetsAt };
          }
        }
        // No writes above this point: a denied reservation leaves both mail and budget state unchanged.
        await tx`
        INSERT INTO mail.ai_daily_mailbox_usage (mailbox_id, day, reserved_calls)
        VALUES (${params.mailboxId}::uuid, ${period.day}::date, ${params.plannedMaxCalls})
        ON CONFLICT (mailbox_id, day) DO UPDATE SET reserved_calls = mail.ai_daily_mailbox_usage.reserved_calls + EXCLUDED.reserved_calls
      `;
        await tx`
        INSERT INTO mail.ai_daily_source_usage (mailbox_id, source_id, day, reserved_calls)
        VALUES (${params.mailboxId}::uuid, ${params.sourceId}, ${period.day}::date, ${params.plannedMaxCalls})
        ON CONFLICT (mailbox_id, source_id, day) DO UPDATE SET reserved_calls = mail.ai_daily_source_usage.reserved_calls + EXCLUDED.reserved_calls
      `;
        const [row] = await tx<StoredReservation[]>`
        INSERT INTO mail.ai_daily_reservations (
          mailbox_id, source_id, reservation_key, source_name, day, time_zone, resets_at, planned_calls, state
        ) VALUES (
          ${params.mailboxId}::uuid, ${params.sourceId}, ${params.reservationKey}, ${params.sourceName},
          ${period.day}::date, ${period.timeZone}, ${period.resetsAt}::timestamptz, ${params.plannedMaxCalls}, 'reserved'
        )
        ON CONFLICT (mailbox_id, source_id, reservation_key) DO UPDATE SET
          source_name = EXCLUDED.source_name, day = EXCLUDED.day, time_zone = EXCLUDED.time_zone,
          resets_at = EXCLUDED.resets_at, planned_calls = EXCLUDED.planned_calls, consumed_calls = 0, state = 'reserved'
        RETURNING source_name, day::text, time_zone, resets_at, planned_calls, consumed_calls, state
      `;
        if (!row) throw new Error("Daily AI reservation insert returned no row");
        return { status: "reserved", reservation: mapReservation(params, row) };
      });
    },
    () => err.internal("Failed to reserve daily AI budget"),
  );
};

const settle = async (params: ReservationKey & BudgetTransaction, actualCalls: number | null): Promise<Result<void>> => {
  if (!validKey(params) || (actualCalls !== null && !validCount(actualCalls))) return fail(err.badInput("Invalid daily AI settlement"));
  return tryCatch(
    () =>
      inTransaction(params.db, async (tx) => {
        await lockMailbox(tx, params.mailboxId, true);
        const row = await readReservation(tx, params);
        // A duplicate release, including one for an operation that was denied, is harmless.
        if (!row && actualCalls === null) return;
        if (!row) throw err.notFound("Daily AI reservation");
        if (actualCalls === null && row.state !== "reserved") return;
        if (actualCalls !== null) {
          if (actualCalls > row.planned_calls) throw err.conflict("Daily AI use exceeds the reserved maximum");
          if (row.state === "consumed" && row.consumed_calls === actualCalls) return;
          if (row.state !== "reserved") throw err.conflict("Daily AI reservation is already settled");
        }
        await tx`
      UPDATE mail.ai_daily_mailbox_usage
      SET reserved_calls = reserved_calls - ${row.planned_calls}, consumed_calls = consumed_calls + ${actualCalls ?? 0}
      WHERE mailbox_id = ${params.mailboxId}::uuid AND day = ${row.day}::date
    `;
        await tx`
      UPDATE mail.ai_daily_source_usage
      SET reserved_calls = reserved_calls - ${row.planned_calls}, consumed_calls = consumed_calls + ${actualCalls ?? 0}
      WHERE mailbox_id = ${params.mailboxId}::uuid AND source_id = ${params.sourceId} AND day = ${row.day}::date
    `;
        await tx`
      UPDATE mail.ai_daily_reservations SET state = ${actualCalls === null ? "released" : "consumed"}, consumed_calls = ${actualCalls ?? 0}
      WHERE mailbox_id = ${params.mailboxId}::uuid AND source_id = ${params.sourceId} AND reservation_key = ${params.reservationKey}
    `;
      }),
    () => err.internal("Failed to settle daily AI budget"),
  );
};

/** Release after failure/cancellation; a later retry may reserve the same key again. Does not undo successful consumption. */
export const releaseAiDailyBudget = (params: ReservationKey & BudgetTransaction): Promise<Result<void>> => settle(params, null);
/** Consume actual successful calls and release the unused planned maximum. Idempotent for the same actual count. */
export const consumeAiDailyBudget = (params: ReservationKey & BudgetTransaction & { actualCalls: number }): Promise<Result<void>> =>
  settle(params, params.actualCalls);

/** Trusted internal read. aiCallsToday excludes holds; limitedUntil includes holds in both scopes. */
export const getAiDailySourceStats = async (params: SourceBudget): Promise<Result<AiDailySourceStats>> => {
  if (!validSource(params) || !validSourceLimit(params.maxAiCallsPerDay)) return fail(err.badInput("Invalid daily AI source budget"));
  return tryCatch(
    async () => {
      const timeZone = await mailboxTimeZone();
      return sql.begin(async (tx) => {
        const mailbox = await lockMailbox(tx, params.mailboxId);
        const period = calendarDay(timeZone);
        const usage = await readUsage(tx, { ...params, day: period.day });
        const limited =
          (params.maxAiCallsPerDay != null && usage.source.consumed + usage.source.reserved >= BigInt(params.maxAiCallsPerDay)) ||
          (mailbox.ai_calls_per_day !== null && usage.mailbox.consumed + usage.mailbox.reserved >= BigInt(mailbox.ai_calls_per_day));
        return {
          aiCallsToday: Number(usage.source.consumed),
          reservedAiCalls: Number(usage.source.reserved),
          maxAiCallsPerDay: params.maxAiCallsPerDay ?? null,
          limitedUntil: limited ? period.resetsAt : null,
          resetsAt: period.resetsAt,
          timeZone,
        };
      });
    },
    () => err.internal("Failed to read daily AI budget"),
  );
};

export const getMailboxAiDailyLimit = async (params: {
  context: MailRequestContext;
  mailboxId: string;
}): Promise<Result<{ maxAiCallsPerDay: number | null }>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, "admin");
  if (!allowed.ok) return fail(allowed.error);
  return tryCatch(
    async () => {
      const [row] = await sql<{ ai_calls_per_day: number | null }[]>`
      SELECT ai_calls_per_day FROM mail.mailboxes WHERE id = ${params.mailboxId}::uuid AND deleted_at IS NULL
    `;
      if (!row) throw err.notFound("Mailbox");
      return { maxAiCallsPerDay: row.ai_calls_per_day };
    },
    () => err.internal("Failed to read mailbox daily AI limit"),
  );
};

/** Mailbox admin setting, using the existing mailbox row, permission, audit, and live invalidation mechanisms. */
export const updateMailboxAiDailyLimit = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  maxAiCallsPerDay: number | null;
}): Promise<Result<{ maxAiCallsPerDay: number | null }>> => {
  if (!validLimit(params.maxAiCallsPerDay) || params.maxAiCallsPerDay === undefined)
    return fail(err.badInput("Invalid mailbox daily AI limit"));
  const result = await tryCatch(
    () =>
      sql.begin(async (tx) => {
        const previous = await lockMailbox(tx, params.mailboxId);
        unwrap(await requireMailboxPermission(params.context, params.mailboxId, "admin", tx));
        await tx`UPDATE mail.mailboxes SET ai_calls_per_day = ${params.maxAiCallsPerDay} WHERE id = ${params.mailboxId}::uuid`;
        await audit.record(
          {
            action: "mail.mailbox.update",
            outcome: "allowed",
            actor: auditActorFromRequest(params.context),
            target: { type: "mailbox", id: params.mailboxId },
            requestId: params.context.requestId,
            metadata: { changed: ["aiCallsPerDay"], previous: previous.ai_calls_per_day, maxAiCallsPerDay: params.maxAiCallsPerDay },
          },
          tx,
        );
        await enqueueMailInvalidation(tx, { mailboxId: params.mailboxId });
        return { maxAiCallsPerDay: params.maxAiCallsPerDay };
      }),
    () => err.internal("Failed to update mailbox daily AI limit"),
  );
  if (result.ok) mailLive.wake();
  return result;
};
