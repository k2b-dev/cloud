import { toPgUuidArray } from "@k2b/cloud/services";
import type { sql } from "bun";
import type { ChatContext } from "./access";
import { type ResourceDecision, readerBatch, readResource, resourceDeferred } from "./resource-access";

export type ThreadReferenceRow = {
  id: string;
  resource_type: string | null;
  resource_id: string | null;
  container_type?: string | null;
  container_id?: string | null;
};
export const threadResource = async (context: ChatContext, row: ThreadReferenceRow) => {
  if (!row.resource_type || !row.resource_id) return null;
  const resource = await readResource(context, { type: row.resource_type, id: row.resource_id });
  if (!resource?.container) return null;
  if (row.container_type && (resource.container.ref.type !== row.container_type || resource.container.ref.id !== row.container_id))
    return null;
  return resource;
};
export const canReadThread = async (db: typeof sql, context: ChatContext, id: string | null) => {
  if (id === null) return true;
  const [row] = await db<
    ThreadReferenceRow[]
  >`SELECT t.id, t.resource_type, t.resource_id, c.resource_type AS container_type, c.resource_id AS container_id
    FROM chat.threads t JOIN chat.conversations c ON c.id = t.conversation_id WHERE t.id = ${id}::uuid`;
  return !!row && (row.resource_type === null || (await threadResource(context, row)) !== null);
};
export const threadDeferred = (context: ChatContext, row: ThreadReferenceRow) =>
  !!row.resource_type && !!row.resource_id && resourceDeferred(context, { type: row.resource_type, id: row.resource_id });
export const inspectedThreadCount = (context: ChatContext, rows: ThreadReferenceRow[]) => {
  const deferred = rows.findIndex((row) => threadDeferred(context, row));
  return deferred < 0 ? rows.length : deferred;
};
export const visibleThreadPage = async <T extends ThreadReferenceRow>(context: ChatContext, rows: T[], prefix = true) => {
  const results = await readerBatch(rows, async (row) => ({ row, resource: await threadResource(context, row) }), context.caller?.signal);
  return results
    .slice(0, prefix ? inspectedThreadCount(context, rows) : rows.length)
    .filter(({ row, resource }) => row.resource_type === null || resource !== null);
};
// Candidate work remains bounded even when all decisions are already cached.
export const SUMMARY_TRAVERSAL_BUDGET = 60;
export type ThreadBudget = { remaining: number };
export const visibleThreadIdPage = async (
  db: typeof sql,
  context: ChatContext,
  conversationId: string,
  after?: string,
  budget: ThreadBudget = { remaining: SUMMARY_TRAVERSAL_BUDGET },
) => {
  context.caller?.signal?.throwIfAborted();
  const [conversation] = await db<
    { kind: string; resource_type: string; resource_id: string }[]
  >`SELECT kind, resource_type, resource_id FROM chat.conversations WHERE id = ${conversationId}::uuid`;
  if (conversation?.kind !== "system") return { ids: undefined, nextCursor: null };
  const limit = Math.min(SUMMARY_TRAVERSAL_BUDGET, budget.remaining);
  const rows = await db<(ThreadReferenceRow & { short_id: string })[]>`SELECT id, short_id, resource_type, resource_id FROM chat.threads
    WHERE conversation_id = ${conversationId}::uuid AND ${after ? db`short_id > ${after}` : db`true`}
    ORDER BY short_id LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  budget.remaining -= page.length;
  const visible = await visibleThreadPage(
    context,
    page.map((row) => ({ ...row, container_type: conversation.resource_type, container_id: conversation.resource_id })),
  );
  const inspected = inspectedThreadCount(context, page);
  return {
    ids: visible.map(({ row }) => row.id),
    nextCursor: rows.length > inspected ? (page[inspected - 1]?.short_id ?? after ?? "") : null,
  };
};
export const messageCondition = (db: typeof sql, ids?: string[]) =>
  ids === undefined ? db`true` : db`(thread_id IS NULL OR thread_id = ANY(${toPgUuidArray(ids)}::uuid[]))`;
/** Authorize a bounded message page. Trim its candidate array before the first deferred
 * message so callers derive continuation only from inspected positions. */
export const visibleMessages = async <T extends { thread_id: string | null }>(
  db: typeof sql,
  context: ChatContext,
  rows: T[],
  backward = false,
) => {
  const ordered = backward ? [...rows].reverse() : rows;
  const ids = [...new Set(ordered.flatMap((row) => (row.thread_id ? [row.thread_id] : [])))];
  if (!ids.length) return rows;
  const threads = await db<
    ThreadReferenceRow[]
  >`SELECT t.id, t.resource_type, t.resource_id, c.resource_type AS container_type, c.resource_id AS container_id
  FROM chat.threads t JOIN chat.conversations c ON c.id = t.conversation_id WHERE t.id = ANY(${toPgUuidArray(ids)}::uuid[])
  ORDER BY array_position(${toPgUuidArray(ids)}::uuid[], t.id)`;
  const visible = new Set((await visibleThreadPage(context, threads, false)).map(({ row }) => row.id));
  const deferred = new Set(threads.filter((row) => threadDeferred(context, row)).map((row) => row.id));
  const boundary = ordered.findIndex((row) => row.thread_id !== null && deferred.has(row.thread_id));
  if (boundary >= 0) {
    if (backward) rows.splice(0, rows.length - boundary);
    else rows.splice(boundary);
  }
  return rows.filter((row) => row.thread_id === null || visible.has(row.thread_id));
};
export const projectResource = (row: ThreadReferenceRow, resource: ResourceDecision | null) =>
  resource && row.resource_type && row.resource_id ? { ref: { type: row.resource_type, id: row.resource_id }, ...resource } : null;
