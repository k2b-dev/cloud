import { toPgUuidArray } from "@k2b/cloud/services";
import type { sql } from "bun";
import type { ChatContext } from "./access";
import { RESOURCE_PAGE_SIZE, type ResourceDecision, readerBatch, readResource } from "./resource-access";

export type ThreadReferenceRow = { id: string; resource_type: string | null; resource_id: string | null };
export const threadResource = async (context: ChatContext, row: ThreadReferenceRow) =>
  row.resource_type && row.resource_id ? readResource(context, { type: row.resource_type, id: row.resource_id }) : null;
export const canReadThread = async (db: typeof sql, context: ChatContext, id: string | null) => {
  if (id === null) return true;
  const [row] = await db<ThreadReferenceRow[]>`SELECT id, resource_type, resource_id FROM chat.threads WHERE id = ${id}::uuid`;
  return !!row && (row.resource_type === null || (await threadResource(context, row)) !== null);
};
export const visibleThreadPage = async <T extends ThreadReferenceRow>(context: ChatContext, rows: T[]) =>
  (await readerBatch(rows, async (row) => ({ row, resource: await threadResource(context, row) }))).filter(
    ({ row, resource }) => row.resource_type === null || resource !== null,
  );
/** Exact aggregates traverse bounded database pages; reader fan-out never exceeds eight. */
export const visibleThreadIds = async (db: typeof sql, context: ChatContext, conversationId: string) => {
  const [conversation] = await db<{ kind: string }[]>`SELECT kind FROM chat.conversations WHERE id = ${conversationId}::uuid`;
  if (conversation?.kind !== "system") return null;
  const ids: string[] = [];
  let after: string | null = null;
  for (;;) {
    context.caller?.signal?.throwIfAborted();
    const rows: ThreadReferenceRow[] = await db<ThreadReferenceRow[]>`SELECT id, resource_type, resource_id FROM chat.threads
      WHERE conversation_id = ${conversationId}::uuid AND ${after ? db`id > ${after}::uuid` : db`true`}
      ORDER BY id LIMIT ${RESOURCE_PAGE_SIZE}`;
    ids.push(...(await visibleThreadPage(context, rows)).map(({ row }) => row.id));
    if (rows.length < RESOURCE_PAGE_SIZE) return ids;
    after = rows.at(-1)!.id;
  }
};
export const visibleMessageCondition = async (db: typeof sql, context: ChatContext, conversationId: string) => {
  const ids = await visibleThreadIds(db, context, conversationId);
  return ids === null ? db`true` : db`(thread_id IS NULL OR thread_id = ANY(${toPgUuidArray(ids)}::uuid[]))`;
};
export const projectResource = (row: ThreadReferenceRow, resource: ResourceDecision | null) =>
  resource?.kind && row.resource_type && row.resource_id
    ? {
        ref: { type: row.resource_type, id: row.resource_id },
        kind: resource.kind,
        status: resource.status,
        done: resource.done,
        href: resource.href,
      }
    : null;
