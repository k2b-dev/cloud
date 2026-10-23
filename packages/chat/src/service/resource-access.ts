import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import { CloudResourceRefSchema } from "@k2b/cloud/contracts";
import { redis } from "bun";
import { z } from "zod";
import type { ChatContext } from "./access";
import { ShortIdSchema } from "./contracts";

export const ACCESS_TTL_SECONDS = 60;
export const READER_CONCURRENCY = 8;
export const RESOURCE_PAGE_SIZE = 100;
export const ContainerRefSchema = CloudResourceRefSchema.extend({
  type: z.enum(["spaces.space", "notebooks.notebook"]),
  id: ShortIdSchema,
});
export const ItemRefSchema = CloudResourceRefSchema.extend({ type: z.enum(["spaces.item", "notebooks.note"]), id: ShortIdSchema });
export type ResourceRef = z.infer<typeof CloudResourceRefSchema>;
const PermissionSchema = z.enum(["read", "write", "admin"]);
export const ResourceDecisionSchema = z.object({
  permission: PermissionSchema,
  name: z.string(),
  description: z.string().nullable(),
  href: z.string(),
  container: ContainerRefSchema.nullable(),
  kind: z.enum(["task", "event", "note"]).nullable(),
  status: z.string().nullable(),
  done: z.boolean(),
  columns: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .max(100)
    .optional(),
  deadline: z.string().nullable().optional(),
  deadlineAllDay: z.boolean().optional(),
  assignees: z.array(z.string()).max(100).optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  allDay: z.boolean().optional(),
});
export type ResourceDecision = z.infer<typeof ResourceDecisionSchema>;
const EnvelopeSchema = z.object({
  data: z.unknown(),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
  page: z.object({ nextCursor: z.string().optional() }).optional(),
});
export type ResourceReaderDependencies = {
  invoke: (
    appId: string,
    capabilityId: string,
    input: Record<string, unknown>,
    caller: CapabilityCaller,
  ) => Promise<z.infer<typeof EnvelopeSchema> | null>;
};
/** Transport seam for tests; production always invokes Core with this request's caller. */
export const resourceReaderDependencies: ResourceReaderDependencies = {
  invoke: async (appId, capabilityId, input, caller) => {
    const result = await invokeCapabilityWithDataSchema({ appId, capabilityId, kind: "query", input }, z.unknown(), caller);
    if (result.ok) return EnvelopeSchema.parse(result.data);
    if (result.error.status === 403 || result.error.status === 404) return null;
    throw new Error("Resource provider unavailable");
  },
};
export const readerBatch = async <T, U>(values: readonly T[], run: (value: T) => Promise<U>, signal?: AbortSignal): Promise<U[]> => {
  const results: U[] = [];
  for (let offset = 0; offset < values.length; offset += READER_CONCURRENCY) {
    signal?.throwIfAborted();
    results.push(...(await Promise.all(values.slice(offset, offset + READER_CONCURRENCY).map(run))));
  }
  return results;
};
export const accessKey = (principal: string, ref: ResourceRef) => `chat:access:v2:${principal}:${ref.type}:${ref.id}`;
export const contextPrincipal = (context: ChatContext) => {
  if (context.credentialPrincipal) return context.credentialPrincipal;
  const subject = context.accessSubject;
  const principal = subject.type === "user" ? `user:${subject.userId}` : `service_account:${subject.serviceAccountId}`;
  return context.actor.kind === "service_account"
    ? `${principal}:scopes=${[...new Set(context.actor.scopes)].sort().join(",")}`
    : principal;
};
export const cachedResource = async (principal: string, ref: ResourceRef): Promise<ResourceDecision | null> => {
  try {
    const value = await redis.get(accessKey(principal, ref));
    return value === null ? null : ResourceDecisionSchema.nullable().parse(JSON.parse(value));
  } catch {
    return null;
  }
};
const ContainerDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  permission: z.enum(["read", "write", "manage", "admin"]),
  columns: z
    .array(z.object({ id: z.string(), name: z.string() }))
    .max(100)
    .optional(),
});
const ItemDataSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  kind: z.enum(["task", "event"]).optional(),
  spaceId: z.string().optional(),
  notebookId: z.string().optional(),
  columnId: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  deadline: z.string().nullable().optional(),
  deadlineAllDay: z.boolean().optional(),
  assignees: z
    .array(z.object({ displayName: z.string() }))
    .max(100)
    .optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  allDay: z.boolean().optional(),
});
export const readResource = async (
  context: ChatContext,
  ref: ResourceRef,
  dependencies = resourceReaderDependencies,
): Promise<ResourceDecision | null> => {
  const key = accessKey(contextPrincipal(context), ref);
  try {
    context.caller?.signal?.throwIfAborted();
    const cached = await redis.get(key);
    if (cached !== null) return ResourceDecisionSchema.nullable().parse(JSON.parse(cached));
    // Live delivery has no interactive credential and may only consume an existing decision.
    if (!context.caller) return null;
    context.caller.signal?.throwIfAborted();
    const container = ContainerRefSchema.safeParse(ref);
    const item = ItemRefSchema.safeParse(ref);
    if (!container.success && !item.success) return null;
    const [appId, type] = ref.type.split(".");
    const result = await dependencies.invoke(appId!, `${type}.read`, { id: ref.id }, context.caller);
    const href = result?.links?.find((link) => link.rel === "open")?.href;
    let decision: ResourceDecision | null = null;
    if (result && href && container.success) {
      const parsed = ContainerDataSchema.safeParse(result.data);
      if (parsed.success && parsed.data.id === ref.id) {
        const data = parsed.data;
        decision = {
          permission: data.permission === "manage" ? "admin" : data.permission,
          name: data.name,
          description: data.description ?? null,
          href,
          container: null,
          kind: null,
          status: null,
          done: false,
          columns: data.columns,
        };
      }
    } else if (result && href && item.success) {
      const parsed = ItemDataSchema.safeParse(result.data);
      if (parsed.success && parsed.data.id === ref.id) {
        const data = parsed.data;
        const parent =
          ref.type === "spaces.item" && data.spaceId && data.kind
            ? { type: "spaces.space" as const, id: data.spaceId }
            : ref.type === "notebooks.note" && data.notebookId
              ? { type: "notebooks.notebook" as const, id: data.notebookId }
              : null;
        if (parent) {
          const containerDecision = ref.type === "spaces.item" ? await readResource(context, parent, dependencies) : null;
          decision = {
            permission: "read",
            name: data.title,
            description: data.description ?? null,
            href,
            container: parent,
            kind: ref.type === "notebooks.note" ? "note" : data.kind!,
            status: containerDecision?.columns?.find((column) => column.id === data.columnId)?.name ?? null,
            ...(data.kind === "task" ? { deadline: data.deadline ?? null, deadlineAllDay: data.deadlineAllDay } : {}),
            assignees: data.assignees?.map((person) => person.displayName),
            ...(data.kind === "event" ? { startsAt: data.startsAt, endsAt: data.endsAt, allDay: data.allDay } : {}),
            done: data.completedAt != null,
          };
        }
      }
    }
    await redis.set(key, JSON.stringify(decision), "EX", ACCESS_TTL_SECONDS);
    return decision;
  } catch {
    // A failed reader or cache never falls back to Chat grants or stale permissions.
    return null;
  }
};
export const readContainers = async (
  context: ChatContext,
  type: z.infer<typeof ContainerRefSchema>["type"],
  cursor?: string,
  dependencies = resourceReaderDependencies,
) => {
  if (!context.caller || cursor === "") return { items: [], nextCursor: null };
  context.caller.signal?.throwIfAborted();
  const [appId, localType] = type.split(".");
  const result = await dependencies.invoke(
    appId!,
    `${localType}.list`,
    { limit: RESOURCE_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
    context.caller,
  );
  // Null means an explicit provider denial; outages and malformed envelopes remain failures.
  if (result === null) return { items: [], nextCursor: null };
  const data = z.array(ContainerDataSchema).max(RESOURCE_PAGE_SIZE).parse(result.data);
  return { items: data.map((entry) => ({ ref: { type, id: entry.id }, name: entry.name })), nextCursor: result.page?.nextCursor ?? null };
};
