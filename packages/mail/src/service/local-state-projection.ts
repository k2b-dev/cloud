import { toPgTextArray } from "@k2b/cloud/services";
import type { sql } from "bun";
import { z } from "zod";

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

const withValue = (values: readonly string[], value: string, present: boolean): string[] =>
  present ? applyStateChange(values, [value], []) : applyStateChange(values, [], [value]);

/** The values one command changed, in the spelling it used. */
const changedValues = (previous: readonly string[], projected: readonly string[]): string[] => [
  ...projected.filter((value) => !includesValue(previous, value)),
  ...previous.filter((value) => !includesValue(projected, value)),
];

const DIMENSIONS = [
  { current: "flags", previous: "previousFlags", projected: "projectedFlags" },
  { current: "keywords", previous: "previousKeywords", projected: "projectedKeywords" },
] as const;

/** A later state command on the same provider message, in queue order. */
export type LaterStateCommand = { id: string; settled: boolean; projection: LocalStateProjection };

const sameValues = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((value) => includesValue(right, value));

/**
 * Undoes what one failed or cancelled state command showed, without touching what other queued commands show.
 *
 * Each value the failed command changed returns to what the message showed before that command, unless a later
 * command that is still due changes the same value: then the message keeps showing the later intent. The later
 * commands learn the earlier state in their snapshots, up to and including the one that changes the value, so each
 * of their own rollbacks restores the provider's state rather than the failed command's. Later commands that already
 * failed or were cancelled undid themselves and are passed over.
 *
 * The message is left as it is when it no longer shows what the queued commands projected, because the sync wrote
 * the provider's state since.
 */
export const planLocalStateRollback = (params: {
  failed: LocalStateProjection;
  current: { flags: readonly string[]; keywords: readonly string[] };
  later: readonly LaterStateCommand[];
}): { flags: string[]; keywords: string[]; laterProjections: Map<string, LocalStateProjection> } => {
  const due = params.later.filter((command) => !command.settled);
  const shown = due.at(-1)?.projection ?? params.failed;
  const unchanged = sameValues(params.current.flags, shown.projectedFlags) && sameValues(params.current.keywords, shown.projectedKeywords);
  const next = { flags: [...params.current.flags], keywords: [...params.current.keywords] };
  const projections = new Map(due.map((command) => [command.id, command.projection]));
  for (const dimension of DIMENSIONS) {
    const previous = params.failed[dimension.previous];
    for (const value of changedValues(previous, params.failed[dimension.projected])) {
      const before = includesValue(previous, value);
      let governed = false;
      for (const command of due) {
        const projection = projections.get(command.id)!;
        const changes = includesValue(projection[dimension.previous], value) !== includesValue(projection[dimension.projected], value);
        projections.set(command.id, {
          ...projection,
          [dimension.previous]: withValue(projection[dimension.previous], value, before),
          // A command that does not change the value showed it as it inherited it.
          ...(changes ? {} : { [dimension.projected]: withValue(projection[dimension.projected], value, before) }),
        });
        if (changes) {
          governed = true;
          break;
        }
      }
      if (!governed && unchanged) next[dimension.current] = withValue(next[dimension.current], value, before);
    }
  }
  const laterProjections = new Map(
    due.flatMap((command) => {
      const projection = projections.get(command.id)!;
      return projection === command.projection ? [] : [[command.id, projection] as const];
    }),
  );
  return { flags: sortValues(next.flags), keywords: sortValues(next.keywords), laterProjections };
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
  // The same queue order the runtime executes commands on one provider message in.
  const later = await tx<{ id: string; state: string; projection: unknown }[]>`
    SELECT later.id, later.state, later.transport_metadata -> 'localStateProjection' AS projection
    FROM mail.commands failed
    JOIN mail.commands later
      ON later.mailbox_id = failed.mailbox_id
     AND later.kind = 'change_message_state'
     AND later.target ->> 'remoteMessageRefId' = ${remoteMessageRefId}
     AND (later.created_at, later.id) > (failed.created_at, failed.id)
     AND later.transport_metadata ? 'localStateProjection'
    WHERE failed.id = ${command.id}::uuid
    ORDER BY later.created_at, later.id
  `;
  const plan = planLocalStateRollback({
    failed: command.projection,
    current: placement,
    later: later.flatMap((row) => {
      const projection = localStateProjectionSchema.safeParse(row.projection);
      return projection.success
        ? [{ id: row.id, settled: row.state === "failed" || row.state === "cancelled", projection: projection.data }]
        : [];
    }),
  });
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
