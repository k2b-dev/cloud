import { toPgTextArray } from "@k2b/cloud/services";
import type { sql } from "bun";
import { z } from "zod";
import { type MessageStateChange, messageStateChangeSchema } from "../contracts";

/**
 * The read, flag, and keyword change a queued state command already shows on one provider message. `previous*` is
 * what the message showed before this command, `projected*` what it shows with it.
 */
export const localStateProjectionSchema = z
  .object({
    remoteMessageRefId: z.string().uuid(),
    previousFlags: z.array(z.string().min(1).max(100)).max(100),
    previousKeywords: z.array(z.string().min(1).max(100)).max(100),
    projectedFlags: z.array(z.string().min(1).max(100)).max(100),
    projectedKeywords: z.array(z.string().min(1).max(100)).max(100),
  })
  .strict();
export type LocalStateProjection = z.infer<typeof localStateProjectionSchema>;

// IMAP flags and keywords compare case-insensitively.
const valueKey = (value: string) => value.toLowerCase();
const includesValue = (values: readonly string[], value: string) => values.some((item) => valueKey(item) === valueKey(value));
const sortValues = (values: string[]) => values.sort((left, right) => left.localeCompare(right));

export const applyStateChange = (current: readonly string[], additions: readonly string[], removals: readonly string[]): string[] => {
  const removed = new Set(removals.map(valueKey));
  const next = current.filter((value) => !removed.has(valueKey(value)));
  const present = new Set(next.map(valueKey));
  for (const value of additions) {
    if (present.has(valueKey(value))) continue;
    next.push(value);
    present.add(valueKey(value));
  }
  return sortValues(next);
};

/** The flag and keyword change of a state command, in IMAP spelling. */
export type ProviderStateChange = {
  addFlags: readonly string[];
  removeFlags: readonly string[];
  addKeywords: readonly string[];
  removeKeywords: readonly string[];
};

const IMAP_SYSTEM_FLAGS = {
  seen: "\\Seen",
  answered: "\\Answered",
  flagged: "\\Flagged",
  draft: "\\Draft",
} as const;

export const providerStateChange = (change: MessageStateChange): ProviderStateChange => ({
  addFlags: change.addFlags.map((flag) => IMAP_SYSTEM_FLAGS[flag]),
  removeFlags: change.removeFlags.map((flag) => IMAP_SYSTEM_FLAGS[flag]),
  addKeywords: change.addKeywords,
  removeKeywords: change.removeKeywords,
});

type ShownState = { flags: readonly string[]; keywords: readonly string[] };

/** A later state command on the same provider message that is still due, in queue order. */
export type LaterStateCommand = { id: string; change: ProviderStateChange; projection: LocalStateProjection };

const sameValues = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value) => includesValue(right, value));
const sameState = (left: ShownState, right: ShownState) => sameValues(left.flags, right.flags) && sameValues(left.keywords, right.keywords);
const previousState = (projection: LocalStateProjection): ShownState => ({
  flags: projection.previousFlags,
  keywords: projection.previousKeywords,
});
const projectedState = (projection: LocalStateProjection): ShownState => ({
  flags: projection.projectedFlags,
  keywords: projection.projectedKeywords,
});

/**
 * Undoes what one failed or cancelled state command showed, without touching what other queued commands show.
 *
 * The message returns to what it showed before the failed command, with the changes of the later commands that are
 * still due applied on top again, in queue order. Each later command learns the state it now builds on, so its own
 * rollback restores the provider's state rather than the failed command's.
 *
 * This holds only while the snapshots form one unbroken chain from the failed command to what the message shows
 * now. When a link differs, the sync wrote the provider's state in between, and the message and the later snapshots
 * are left as they are.
 */
export const planLocalStateRollback = (params: {
  failed: LocalStateProjection;
  current: ShownState;
  later: readonly LaterStateCommand[];
}): { flags: string[]; keywords: string[]; laterProjections: Map<string, LocalStateProjection> } => {
  const unchanged = { flags: [...params.current.flags], keywords: [...params.current.keywords], laterProjections: new Map() };
  let shown = projectedState(params.failed);
  for (const command of params.later) {
    if (!sameState(shown, previousState(command.projection))) return unchanged;
    shown = projectedState(command.projection);
  }
  if (!sameState(params.current, shown)) return unchanged;

  let state: ShownState = previousState(params.failed);
  const laterProjections = new Map<string, LocalStateProjection>();
  for (const command of params.later) {
    const projection: LocalStateProjection = {
      ...command.projection,
      previousFlags: [...state.flags],
      previousKeywords: [...state.keywords],
      projectedFlags: applyStateChange(state.flags, command.change.addFlags, command.change.removeFlags),
      projectedKeywords: applyStateChange(state.keywords, command.change.addKeywords, command.change.removeKeywords),
    };
    if (
      !sameState(previousState(projection), previousState(command.projection)) ||
      !sameState(projectedState(projection), projectedState(command.projection))
    ) {
      laterProjections.set(command.id, projection);
    }
    state = projectedState(projection);
  }
  return { flags: sortValues([...state.flags]), keywords: sortValues([...state.keywords]), laterProjections };
};

/** Rolls back the local state a failed or cancelled command projected, inside the transaction that settles it. */
export const rollbackLocalStateProjection = async (
  tx: typeof sql,
  command: { id: string; projection: LocalStateProjection },
): Promise<void> => {
  const remoteMessageRefId = command.projection.remoteMessageRefId;
  const [placement] = await tx<{ flags: string[]; keywords: string[] }[]>`
    SELECT flags, keywords
    FROM mail.message_placements
    WHERE remote_message_ref_id = ${remoteMessageRefId}::uuid
    FOR UPDATE
  `;
  if (!placement) return;
  // The later commands that are still due, in the queue order the runtime executes them on one provider message.
  const rows = await tx<{ id: string; payload: unknown; projection: unknown }[]>`
    SELECT later.id, later.payload, later.transport_metadata -> 'localStateProjection' AS projection
    FROM mail.commands failed
    JOIN mail.commands later
      ON later.mailbox_id = failed.mailbox_id
     AND later.state IN ('queued', 'executing', 'ambiguous')
     AND later.kind = 'change_message_state'
     AND later.target ->> 'remoteMessageRefId' = ${remoteMessageRefId}
     AND (later.created_at, later.id) > (failed.created_at, failed.id)
     AND later.transport_metadata ? 'localStateProjection'
    WHERE failed.id = ${command.id}::uuid
    ORDER BY later.created_at, later.id
  `;
  const later: LaterStateCommand[] = [];
  for (const row of rows) {
    const change = messageStateChangeSchema.safeParse(row.payload);
    const projection = localStateProjectionSchema.safeParse(row.projection);
    // Without a readable later command the chain cannot be followed: leave the message as it is.
    if (!change.success || !projection.success) return;
    later.push({ id: row.id, change: providerStateChange(change.data), projection: projection.data });
  }
  const plan = planLocalStateRollback({ failed: command.projection, current: placement, later });
  if (!sameValues(plan.flags, placement.flags) || !sameValues(plan.keywords, placement.keywords)) {
    await tx`
      UPDATE mail.message_placements
      SET
        flags = ${toPgTextArray(plan.flags)}::text[],
        keywords = ${toPgTextArray(plan.keywords)}::text[],
        updated_at = now()
      WHERE remote_message_ref_id = ${remoteMessageRefId}::uuid
    `;
  }
  for (const [laterId, projection] of plan.laterProjections) {
    await tx`
      UPDATE mail.commands
      SET transport_metadata = transport_metadata || ${{ localStateProjection: projection }}::jsonb
      WHERE id = ${laterId}::uuid
    `;
  }
};
