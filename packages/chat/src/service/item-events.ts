import { fail, ok, type Result } from "@k2b/cloud/server";
import { toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { type ChatContext, messages, requireConversation } from "./access";
import { ItemEventSchema, type ItemEventsPageSchema, ItemEventsQuerySchema } from "./contracts";
import { ContainerRefSchema, ItemRefSchema, readerBatch, readResource, resourceReaderDependencies } from "./resource-access";
import { findThread, threadNotFound } from "./threads";

const OwnerEventSchema = z.object({
  id: z.string().max(100),
  at: z.string().datetime({ offset: true }),
  ref: ItemRefSchema.nullable(),
  title: z.string().max(500).nullable().optional(),
  actor: z.object({ type: z.enum(["user", "service_account", "system"]), id: z.uuid().nullable(), name: z.string().max(1000) }),
  icon: z
    .string()
    .regex(/^ti ti-[a-z0-9-]+$/)
    .max(80),
  sentence: z.string().max(4000),
  href: ItemEventSchema.shape.href,
  count: z.number().int().min(1),
});
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
  container: z.infer<typeof ContainerRefSchema>,
  query: z.output<typeof ItemEventsQuerySchema>,
  item?: ItemRef,
  timeZone?: string,
): { appId: "spaces" | "notebooks"; capabilityId: "space.activity" | "notebook.activity"; input: Record<string, unknown> } => ({
  appId: container.type === "spaces.space" ? "spaces" : "notebooks",
  capabilityId: container.type === "spaces.space" ? "space.activity" : "notebook.activity",
  input: {
    [container.type === "spaces.space" ? "space" : "notebook"]: container.id,
    ...(item ? { item: item.id } : {}),
    ...(container.type === "spaces.space" && timeZone ? { timeZone } : {}),
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
    let item: ItemRef | undefined;
    if (query.thread !== "all") {
      const thread = await findThread(sql, conversation.id, query.thread, input);
      const ref = ItemRefSchema.safeParse({ type: thread?.resource_type, id: thread?.resource_id });
      if (!ref.success) return threadNotFound(input);
      const decision = await readResource(input, ref.data);
      if (decision?.container?.type !== container.data.type || decision.container.id !== container.data.id) return threadNotFound(input);
      item = ref.data;
    }
    const request = activityQuery(container.data, query, item, input.timeZone);
    let page: { items: OwnerEvent[]; nextCursor: string | null };
    try {
      input.caller.signal?.throwIfAborted();
      const response = await resourceReaderDependencies.invoke(request.appId, request.capabilityId, request.input, input.caller);
      if (response === null) return notFound();
      page = {
        items: OwnerActivitySchema.max(query.limit).parse(response.data),
        nextCursor: z
          .string()
          .max(256)
          .nullable()
          .parse(response.page?.nextCursor ?? null),
      };
    } catch {
      input.caller.signal?.throwIfAborted();
      return ok({ items: [], nextCursor: null, unavailable: true });
    }
    const type = container.data.type === "spaces.space" ? "spaces.item" : "notebooks.note";
    const events = page.items.flatMap((event) =>
      event.ref?.type === type && (!item || item.id === event.ref.id) ? [{ ...event, ref: event.ref }] : [],
    );
    const threads = events.length
      ? await sql<EventThread[]>`SELECT short_id, resource_type, resource_id FROM chat.threads
      WHERE conversation_id = ${conversation.id}::uuid AND resource_type = ${type}
      AND resource_id = ANY(${toPgTextArray(events.map((event) => event.ref.id))}::text[])`
      : [];
    const rows = await readerBatch(
      events,
      async (event) => {
        const thread = threads.find((candidate) => candidate.resource_id === event.ref.id);
        if (!thread) return mapItemEvent(event);
        const resource = await readResource(input, event.ref);
        if (!resource || resource.container?.type !== container.data.type || resource.container.id !== container.data.id) return null;
        return mapItemEvent(event, { id: thread.short_id, name: resource.name });
      },
      input.caller.signal,
    );
    return ok({ items: rows.filter((row) => row !== null), nextCursor: page.nextCursor });
  },
};
