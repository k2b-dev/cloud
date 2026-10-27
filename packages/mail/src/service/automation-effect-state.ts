import { sql } from "bun";
import type { AutomationLogItem } from "../contracts";
import { undoMoveCopyQuery } from "./command-undo";

export type AutomationEffectClass = "tag" | "status" | "placement" | "flag" | "keyword";
export type AutomationEffect = AutomationLogItem["effects"][number];
export type AutomationEffectRow = {
  id: string;
  effect_class: AutomationEffectClass;
  effect: AutomationEffect;
  target_id: string;
  value: string;
  before_value: string | boolean;
  after_value: string | boolean;
  command_id: string | null;
  source_command_id: string | null;
  changed_at: Date | null;
  undone: boolean;
};

/** Called under the mailbox/conversation or provider-command lock. */
export const automationEffectWasUndone = async (
  db: typeof sql,
  input: { conversationId: string; workflowVersionId: string; effectClass: AutomationEffectClass },
): Promise<boolean> => {
  const [row] = await db<{ present: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM mail.automation_effect_undone marker JOIN workflows.version version ON version.workflow_id = marker.workflow_id
    WHERE marker.conversation_id = ${input.conversationId}::uuid AND version.id = ${input.workflowVersionId}::uuid
      AND marker.effect_class = ${input.effectClass}
  ) AS present`;
  return row?.present ?? false;
};

export const recordAutomationEffect = async (
  db: typeof sql,
  input: {
    mailboxId: string;
    conversationId: string;
    runId: string;
    effectKey: string;
    effectClass: AutomationEffectClass;
    effect: AutomationEffect;
    targetId: string;
    value?: string;
    before: string | boolean;
    after: string | boolean;
    commandId?: string;
  },
): Promise<void> => {
  await db`INSERT INTO mail.automation_effect
    (mailbox_id, conversation_id, run_id, effect_key, effect_class, effect, target_id, value, before_value, after_value, command_id, source_command_id)
    VALUES (${input.mailboxId}::uuid, ${input.conversationId}::uuid, ${input.runId}::uuid, ${input.effectKey},
      ${input.effectClass}, ${input.effect}, ${input.targetId}::uuid, ${input.value ?? ""}, ${typeof input.before === "boolean" ? sql`to_jsonb(${input.before}::boolean)` : sql`to_jsonb(${input.before}::text)`},
      ${typeof input.after === "boolean" ? sql`to_jsonb(${input.after}::boolean)` : sql`to_jsonb(${input.after}::text)`}, ${input.commandId ?? null}::uuid, ${input.commandId ?? null}::uuid)
    ON CONFLICT (run_id, conversation_id, effect_class, target_id, value) DO UPDATE
      SET after_value = EXCLUDED.after_value, effect = EXCLUDED.effect, command_id = EXCLUDED.command_id, source_command_id = EXCLUDED.source_command_id, changed_at = NULL
      WHERE mail.automation_effect.effect_key <> EXCLUDED.effect_key`;
};

/** Any intervening writer invalidates provenance, including changing away and back. */
export const invalidateAutomationEffects = async (
  db: typeof sql,
  conversationId: string,
  effectClass: AutomationEffectClass,
  targetIds?: string[],
  value?: string,
): Promise<void> => {
  await db`UPDATE mail.automation_effect SET changed_at = now()
    WHERE conversation_id = ${conversationId}::uuid AND effect_class = ${effectClass} AND changed_at IS NULL
      AND (${targetIds === undefined} OR target_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${targetIds ?? []}::jsonb)))
      AND (${value ?? null}::text IS NULL OR value = ${value ?? null})`;
};

export const loadAutomationEffects = async (
  db: typeof sql,
  runId: string | null,
  conversationId: string | null,
): Promise<AutomationEffectRow[]> => {
  const rows = await db<
    AutomationEffectRow[]
  >`SELECT effect.*, before_value::text AS before_value, after_value::text AS after_value FROM mail.automation_effect effect
    WHERE run_id = ${runId}::uuid AND conversation_id = ${conversationId}::uuid AND before_value <> after_value
      AND (source_command_id IS NULL OR EXISTS (SELECT 1 FROM mail.commands command
        WHERE command.id = effect.source_command_id AND command.state IN ('confirmed', 'reconciled'))) ORDER BY id`;
  // Bun decodes JSON objects, but returns JSON scalar values as their serialized text.
  const scalar = (value: string | boolean): string | boolean => {
    if (typeof value !== "string") return value;
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "string" && typeof parsed !== "boolean") throw new Error("Invalid automation effect state");
    return parsed;
  };
  return rows.map((row) => ({ ...row, before_value: scalar(row.before_value), after_value: scalar(row.after_value) }));
};

/** Group transitions must not strand effects whose original or inverse command is still running. */
export const automationEffectsPending = async (db: typeof sql, runId: string | null, conversationId: string | null): Promise<boolean> => {
  const [row] = await db<{ pending: boolean }[]>`SELECT EXISTS (
    SELECT 1 FROM mail.automation_effect effect JOIN mail.commands command
      ON command.id = effect.command_id OR command.id = effect.source_command_id
    WHERE effect.run_id = ${runId}::uuid AND effect.conversation_id = ${conversationId}::uuid
      AND command.state IN ('queued', 'executing', 'ambiguous')
  ) AS pending`;
  return row?.pending ?? false;
};

/** The comparison also catches changes learned from another mail client. */
export const automationEffectCurrent = async (
  db: typeof sql,
  row: AutomationEffectRow,
  conversationId: string,
): Promise<"current" | "changed_by_person" | "gone" | "pending"> => {
  if (row.changed_at) return "changed_by_person";
  const expected = row.undone ? row.before_value : row.after_value;
  if (row.effect_class === "tag") {
    const [tag] = await db<{ present: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM mail.conversation_local_tags WHERE conversation_id = ${conversationId}::uuid AND tag_id = tag.id
    ) AS present FROM mail.local_tags tag WHERE tag.id = ${row.target_id}::uuid`;
    return !tag ? "gone" : tag.present === expected ? "current" : "changed_by_person";
  }
  if (row.effect_class === "status") {
    const [conversation] = await db<
      { work_status: string }[]
    >`SELECT work_status FROM mail.conversations WHERE id = ${conversationId}::uuid`;
    return !conversation ? "gone" : conversation.work_status === expected ? "current" : "changed_by_person";
  }
  const [command] = await db<{ state: string }[]>`SELECT state FROM mail.commands WHERE id = ${row.command_id}::uuid`;
  if (!command) return "gone";
  if (["queued", "executing", "ambiguous"].includes(command.state)) return "pending";
  if (!["confirmed", "reconciled"].includes(command.state)) return "changed_by_person";
  if (row.effect_class === "placement") {
    const [folder] = await db<
      { present: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM mail.folders WHERE id = ${String(expected)}::uuid) AS present`;
    if (!folder?.present) return "gone";
    const [command] = await db<
      { mailbox_id: string; created_at: Date }[]
    >`SELECT mailbox_id, created_at FROM mail.commands WHERE id = ${row.command_id}::uuid`;
    if (!command) return "gone";
    const [ref] = await undoMoveCopyQuery(db, {
      mailboxId: command.mailbox_id,
      commandId: row.command_id!,
      messageId: row.target_id,
      destinationFolderId: String(expected),
      createdAt: command.created_at,
    });
    return ref ? "current" : "changed_by_person";
  }
  const ref = await automationEffectProviderRef(db, row);
  if (!ref) return "gone";
  const [placement] = await db<{ present: boolean }[]>`SELECT ${row.value} = ANY(
    ${row.effect_class === "flag" ? sql`flags` : sql`keywords`}) AS present
    FROM mail.message_placements WHERE remote_message_ref_id = ${ref.id}::uuid AND deleted_at IS NULL`;
  return !placement ? "gone" : placement.present === expected ? "current" : "changed_by_person";
};

/** Prefer the actual command target, then its moved copy; never choose arbitrarily among copies. */
export const automationEffectProviderRef = async (
  db: typeof sql,
  row: AutomationEffectRow,
): Promise<{ id: string; folder_id: string } | null> => {
  if (row.effect_class === "placement") {
    const [command] = await db<
      { mailbox_id: string; created_at: Date }[]
    >`SELECT mailbox_id, created_at FROM mail.commands WHERE id = ${row.command_id}::uuid`;
    if (!command) return null;
    const folderId = String(row.undone ? row.before_value : row.after_value);
    const [ref] = await undoMoveCopyQuery(db, {
      mailboxId: command.mailbox_id,
      commandId: row.command_id!,
      messageId: row.target_id,
      destinationFolderId: folderId,
      createdAt: command.created_at,
    });
    return ref ? { id: ref.id, folder_id: folderId } : null;
  }
  const refs = await db<{ id: string; folder_id: string; original: boolean }[]>`SELECT ref.id, ref.folder_id,
    ref.id::text = command.target->>'remoteMessageRefId' AS original
    FROM mail.remote_message_refs ref JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id
    LEFT JOIN mail.commands command ON command.id = ${row.command_id}::uuid
    WHERE ref.message_id = ${row.target_id}::uuid AND ref.stale_at IS NULL AND placement.deleted_at IS NULL
    ORDER BY (ref.id::text = command.target->>'remoteMessageRefId') DESC NULLS LAST, ref.id`;
  if (refs[0]?.original || refs.length === 1) return refs[0]!;
  return null;
};
