import type { DiscussionProvider } from "@k2b/cloud/capabilities/server";
import { ResourceActivityEventSchema } from "@k2b/cloud/contracts";
import { fail, ok, type Result } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { type ChatContext, messages, requireConversation } from "./access";
import { type ItemEventsPageSchema, ItemEventsQuerySchema } from "./contracts";
import { discussionRead, providerFor } from "./discussion-read";
import { ContainerRefSchema, ItemRefSchema, invokeDiscussion, readerBatch, readResource } from "./resource-access";
import { findThread, threadNotFound } from "./threads";

const OwnerEventSchema = ResourceActivityEventSchema;
export const OwnerActivitySchema = z.array(OwnerEventSchema).max(100);
type OwnerEvent = z.infer<typeof OwnerEventSchema>;
type ItemRef = z.infer<typeof ItemRefSchema>;
type EventThread = { short_id: string; resource_type: string; resource_id: string };

/** A resource without a Chat thread remains openable through threads/for-resource. */
export const mapItemEvent = (event: OwnerEvent & { ref: ItemRef }, thread?: { id: string; name: string }) => ({
  id: event.id,
  at: event.at,
  icon: event.icon,
  sentence: event.sentence,
  count: event.count,
  ...(event.href === undefined ? {} : { href: event.href }),
  thread: thread ?? { ref: event.ref, name: event.title ?? "" },
});
export const activityQuery = (
  provider: Pick<DiscussionProvider, "app" | "activity">,
  container: z.infer<typeof ContainerRefSchema>,
  query: z.output<typeof ItemEventsQuerySchema>,
  item?: ItemRef,
  timeZone?: string,
) => ({
  appId: provider.app.appId,
  capabilityId: provider.activity!,
  input: {
    container: container.id,
    ...(item ? { item: item.id } : {}),
    ...(timeZone ? { timeZone } : {}),
    before: query.before,
    after: query.after,
    cursor: query.cursor,
    limit: query.limit,
  },
});

export const itemEvents = {
  list: async (
    input: ChatContext & { conversationId: string; query: unknown; timeZone?: string },
  ): Promise<Result<z.infer<typeof ItemEventsPageSchema>>> => {
    const query = ItemEventsQuerySchema.parse(input.query);
    const notFound = () => fail({ code: "NOT_FOUND", message: messages(input).notFound, status: 404 });
    const access = await requireConversation({ ...input, required: "read" });
    if (!access.ok) return notFound();
    const conversation = access.data;
    const container = ContainerRefSchema.safeParse({ type: conversation.resource_type, id: conversation.resource_id });
    if (conversation.kind !== "system" || !container.success || !input.caller) return notFound();
    const provider = await providerFor(input, container.data.type, "container").catch(() => null);
    if (!provider) return ok({ items: [], nextCursor: query.cursor ?? null, unavailable: true });
    if (!provider.activity) return ok({ items: [], nextCursor: null });
    let item: ItemRef | undefined;
    if (query.thread !== "all") {
      const thread = await findThread(sql, conversation.id, query.thread, input);
      const ref = ItemRefSchema.safeParse({ type: thread?.resource_type, id: thread?.resource_id });
      if (!ref.success || ref.data.type !== provider.itemType) return threadNotFound(input);
      const decision = await readResource(input, ref.data);
      if (decision?.container?.ref.type !== container.data.type || decision.container.ref.id !== container.data.id)
        return threadNotFound(input);
      item = ref.data;
    }
    // Reserve one reader per event before requesting the owner page. Repeated refs cost less,
    // but the worst case must fit without advancing past unreadable work.
    const limit = Math.min(query.limit, discussionRead(input).remaining - 1);
    if (limit < 1) return ok({ items: [], nextCursor: query.cursor ?? null, unavailable: true });
    const request = activityQuery(provider, container.data, { ...query, limit }, item, input.timeZone);
    let page: { items: OwnerEvent[]; nextCursor: string | null };
    try {
      input.caller.signal?.throwIfAborted();
      const response = await invokeDiscussion(input, request.appId, request.capabilityId, request.input);
      if (response === null) return notFound();
      page = {
        items: OwnerActivitySchema.max(limit).parse(response.data),
        nextCursor: z
          .string()
          .max(2048)
          .nullable()
          .parse(response.page?.nextCursor ?? null),
      };
      if (page.nextCursor !== null && page.nextCursor === query.cursor) throw new Error("Activity cursor did not advance");
    } catch {
      input.caller.signal?.throwIfAborted();
      return ok({ items: [], nextCursor: query.cursor ?? null, unavailable: true });
    }
    const type = provider.itemType;
    const events = page.items.flatMap((event) =>
      event.ref?.type === type && (!item || item.id === event.ref.id) ? [{ ...event, ref: event.ref }] : [],
    );
    const threads = events.length
      ? await sql<EventThread[]>`SELECT short_id, resource_type, resource_id FROM chat.threads
      WHERE conversation_id = ${conversation.id}::uuid AND resource_type = ${type}
      AND resource_id = ANY(${toPgTextArray(events.map((event) => event.ref.id))}::text[])`
      : [];
    try {
      const refs = [...new Map(events.map((event) => [event.ref.id, event.ref])).values()];
      let unavailable = false;
      const decisions = new Map(
        await readerBatch(
          refs,
          async (ref) =>
            [
              ref.id,
              await readResource(input, ref, undefined, () => {
                unavailable = true;
              }),
            ] as const,
          input.caller.signal,
        ),
      );
      if (unavailable) return ok({ items: [], nextCursor: query.cursor ?? null, unavailable: true });
      const rows = events.flatMap((event) => {
        const resource = decisions.get(event.ref.id);
        if (!resource || resource.container?.ref.type !== container.data.type || resource.container.ref.id !== container.data.id) return [];
        const thread = threads.find((candidate) => candidate.resource_id === event.ref.id);
        return [mapItemEvent(event, thread ? { id: thread.short_id, name: resource.title } : undefined)];
      });
      return ok({ items: rows, nextCursor: page.nextCursor });
    } catch {
      input.caller.signal?.throwIfAborted();
      return ok({ items: [], nextCursor: query.cursor ?? null, unavailable: true });
    }
  },
};
