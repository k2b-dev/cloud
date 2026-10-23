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
  (await readerBatch(rows, async (row) => ({ row, resource: await threadResource(context, row) }), context.caller?.signal)).filter(
    ({ row, resource }) => row.resource_type === null || resource !== null,
  );
/** One request spends at most one 100-candidate page on summary item readers.
 * Together with the two 100-container discovery pages this is <= 302 reader
 * invocations (including both list calls), never 200 nested thread traversals.
 */
export const READER_REQUEST_BUDGET = 3 * RESOURCE_PAGE_SIZE + 2;
// Reserve both discovery calls and their container readers; spend the rest once.
export const SUMMARY_TRAVERSAL_BUDGET = READER_REQUEST_BUDGET - 2 * (RESOURCE_PAGE_SIZE + 1);
export type ThreadBudget = { remaining: number };
export const visibleThreadIdPage = async (
  db: typeof sql,
  context: ChatContext,
  conversationId: string,
  after?: string,
  budget: ThreadBudget = { remaining: SUMMARY_TRAVERSAL_BUDGET },
) => {
  context.caller?.signal?.throwIfAborted();
  const [conversation] = await db<{ kind: string }[]>`SELECT kind FROM chat.conversations WHERE id = ${conversationId}::uuid`;
  if (conversation?.kind !== "system") return { ids: undefined, nextCursor: null };
  const limit = budget.remaining;
  const rows = await db<(ThreadReferenceRow & { short_id: string })[]>`SELECT id, short_id, resource_type, resource_id FROM chat.threads
    WHERE conversation_id = ${conversationId}::uuid AND ${after ? db`short_id > ${after}` : db`true`}
    ORDER BY short_id LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  budget.remaining -= page.length;
  return {
    ids: (await visibleThreadPage(context, page)).map(({ row }) => row.id),
    nextCursor: rows.length > limit ? (page.at(-1)?.short_id ?? after ?? "") : null,
  };
};
export const messageCondition = (db: typeof sql, ids?: string[]) =>
  ids === undefined ? db`true` : db`(thread_id IS NULL OR thread_id = ANY(${toPgUuidArray(ids)}::uuid[]))`;
/** Authorize only the threads in an already bounded message candidate page. */
export const visibleMessages = async <T extends { thread_id: string | null }>(db: typeof sql, context: ChatContext, rows: T[]) => {
  const ids = [...new Set(rows.flatMap((row) => (row.thread_id ? [row.thread_id] : [])))];
  if (!ids.length) return rows;
  const threads = await db<
    ThreadReferenceRow[]
  >`SELECT id, resource_type, resource_id FROM chat.threads WHERE id = ANY(${toPgUuidArray(ids)}::uuid[])`;
  const visible = new Set((await visibleThreadPage(context, threads)).map(({ row }) => row.id));
  return rows.filter((row) => row.thread_id === null || visible.has(row.thread_id));
};
export const projectResource = (row: ThreadReferenceRow, resource: ResourceDecision | null) =>
  resource?.kind && row.resource_type && row.resource_id
    ? {
        ref: { type: row.resource_type, id: row.resource_id },
        kind: resource.kind,
        status: resource.status,
        deadline: resource.deadline,
        deadlineAllDay: resource.deadlineAllDay,
        assignees: resource.assignees,
        startsAt: resource.startsAt,
        endsAt: resource.endsAt,
        allDay: resource.allDay,
        done: resource.done,
        href: resource.href,
      }
    : null;
