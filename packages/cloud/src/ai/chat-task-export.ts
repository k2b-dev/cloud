import { z } from "zod";
import type { RequestActor } from "../contracts/shared";
import { sql } from "../runtime/clients";
import { accounts } from "../services/accounts";

export const ChatTaskExportQuerySchema = z
  .object({
    after: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .strict();
export const ChatTaskExportEntrySchema = z.object({
  kind: z.literal("chat-task"),
  id: z.string(),
  ownerUserId: z.string().uuid(),
  title: z.string().nullable(),
  prompt: z.string(),
  locale: z.string().nullable(),
  targetChat: z.object({ id: z.string(), title: z.string() }),
  schedule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("once"), runAt: z.string() }),
    z.object({ kind: z.literal("cron"), cron: z.string() }),
  ]),
  timezone: z.string(),
  grants: z.array(z.json()),
  mandateSummary: z
    .object({
      id: z.string().uuid(),
      revision: z.number().int(),
      state: z.string(),
      expiresAt: z.string().nullable(),
      apps: z.json(),
      operations: z.json(),
      actions: z.string(),
    })
    .nullable(),
  state: z.enum(["active", "paused", "completed", "needs_attention"]),
  revision: z.number().int(),
  reasonCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const ChatTaskExportPageSchema = z.object({
  format: z.literal("cloud.chat-tasks"),
  version: z.literal(1),
  authority: z.literal("none"),
  scope: z.enum(["person", "installation"]),
  exportedAt: z.string(),
  items: z.array(ChatTaskExportEntrySchema),
  nextCursor: z.string().uuid().nullable(),
});
export type ChatTaskExportPage = z.infer<typeof ChatTaskExportPageSchema>;

export class ChatTaskExportForbiddenError extends Error {}

/** Read-only evidence. All ownership and current admin checks live here, for every transport. */
export const exportChatTasks = async (
  actor: RequestActor,
  input: { all?: boolean; after?: string; limit?: number } = {},
): Promise<ChatTaskExportPage> => {
  const page = ChatTaskExportQuerySchema.parse({ after: input.after, limit: input.limit });
  const person = actor.kind === "user" ? actor.user : actor.delegatedUser;
  if (!person) throw new ChatTaskExportForbiddenError("Routine exports require a user-backed actor");
  if (input.all) {
    if (actor.kind !== "user" || actor.delegation)
      throw new ChatTaskExportForbiddenError("Sign in as a Cloud administrator to export the installation");
    const current = person.roles.includes("admin") ? await accounts.users.get({ id: person.id }) : null;
    if (!current?.roles.includes("admin") || accounts.model.isAccountExpired(current.accountExpires))
      throw new ChatTaskExportForbiddenError("Cloud administration access is required");
  }
  const [archive] = await sql<{ present: boolean }[]>`SELECT to_regclass('ai.chat_tasks') IS NOT NULL AS present`;
  const rows = archive?.present
    ? await sql<{ entry: unknown; cursor: string }[]>`
    SELECT task.id::text AS cursor, jsonb_build_object(
      'kind', 'chat-task', 'id', task.short_id, 'ownerUserId', task.sponsor_user_id,
      'title', task.title, 'prompt', task.prompt, 'locale', task.locale,
      'targetChat', jsonb_build_object('id', COALESCE(conversation.short_id, task.conversation_id::text), 'title', COALESCE(conversation.title, '')),
      'schedule', CASE WHEN task.schedule_kind = 'once' THEN jsonb_build_object('kind', 'once', 'runAt', task.run_at)
        ELSE jsonb_build_object('kind', 'cron', 'cron', task.cron) END,
      'timezone', task.timezone, 'grants', COALESCE(snapshot.record->'policy'->'grants', '[]'::jsonb),
      'mandateSummary', CASE WHEN snapshot.record IS NULL THEN NULL ELSE jsonb_build_object(
        'id', snapshot.record->'id', 'revision', snapshot.record->'revision', 'state', snapshot.record->'state', 'expiresAt', snapshot.record->'expires_at',
        'apps', snapshot.record->'policy'->'apps', 'operations', snapshot.record->'policy'->'operations', 'actions', snapshot.record->'policy'->>'actions') END,
      'state', task.state, 'revision', task.revision, 'reasonCode', task.reason_code,
      'createdAt', task.created_at, 'updatedAt', task.updated_at
    ) AS entry
    FROM ai.chat_tasks task
    LEFT JOIN ai.conversations conversation ON conversation.id = task.conversation_id
    LEFT JOIN auth.mandates mandate ON mandate.id = task.mandate_id
    CROSS JOIN LATERAL (SELECT COALESCE(task.retired_mandate, to_jsonb(mandate)) AS record) snapshot
    WHERE (${input.all ?? false} OR task.sponsor_user_id = ${person.id}::uuid)
      AND (${page.after ?? null}::uuid IS NULL OR task.id > ${page.after ?? null}::uuid)
    ORDER BY task.id LIMIT ${page.limit + 1}
  `
    : [];
  const selected = rows.slice(0, page.limit);
  return {
    format: "cloud.chat-tasks",
    version: 1,
    authority: "none",
    scope: input.all ? "installation" : "person",
    exportedAt: new Date().toISOString(),
    items: selected.map((row) => {
      const parsed = ChatTaskExportEntrySchema.safeParse(row.entry);
      if (!parsed.success) throw new Error(`Cannot export routine ${row.cursor}: invalid stored definition`);
      return parsed.data;
    }),
    nextCursor: rows.length > page.limit ? selected.at(-1)!.cursor : null,
  };
};
