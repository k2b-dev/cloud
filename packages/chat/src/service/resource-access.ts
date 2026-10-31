import { redis } from "@k2b/cloud";
import { type CapabilityCaller, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import {
  CapabilitySemanticLinkSchema,
  CloudResourceReaderViewSchema,
  CloudResourceRefSchema,
  DiscussionContainersDataSchema,
} from "@k2b/cloud/contracts";
import { z } from "zod";
import type { ChatContext } from "./access";
import {
  DISCUSSION_CONCURRENCY,
  DiscussionReadStopped,
  discussionIcon,
  discussionRead,
  providerFor,
  typePresentation,
} from "./discussion-read";

export const ACCESS_TTL_SECONDS = 60;
export const READER_CONCURRENCY = DISCUSSION_CONCURRENCY;
export const RESOURCE_PAGE_SIZE = 100;
export const ContainerRefSchema = CloudResourceRefSchema;
export const ItemRefSchema = CloudResourceRefSchema;
export type ResourceRef = z.infer<typeof CloudResourceRefSchema>;
export const ResourceDecisionSchema = CloudResourceReaderViewSchema.extend({
  href: CapabilitySemanticLinkSchema.shape.href.optional(),
  typeTitle: z.string(),
  icon: z.string().transform(discussionIcon),
  color: z.string().optional(),
});
export type ResourceDecision = z.infer<typeof ResourceDecisionSchema>;
const AuthorizationSchema = ResourceDecisionSchema.pick({ permission: true, container: true }).strip();
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
export const accessKey = (principal: string, ref: ResourceRef, locale = "en") =>
  `chat:access:v3:${JSON.stringify([principal, ref.type, ref.id, locale])}`;
export const authorizationKey = (principal: string, ref: ResourceRef) =>
  `chat:authorization:v1:${JSON.stringify([principal, ref.type, ref.id])}`;
export const contextPrincipal = (context: ChatContext) => {
  if (context.credentialPrincipal) return context.credentialPrincipal;
  const subject = context.accessSubject;
  const principal = subject.type === "user" ? `user:${subject.userId}` : `service_account:${subject.serviceAccountId}`;
  return context.actor.kind === "service_account"
    ? `${principal}:scopes=${[...new Set(context.actor.scopes)].sort().join(",")}`
    : principal;
};
/** Live delivery needs only authority, independent of the locale of the last HTTP read. */
export const cachedResource = async (principal: string, ref: ResourceRef) => {
  try {
    const value = await redis.get(authorizationKey(principal, ref));
    return value === null ? null : AuthorizationSchema.nullable().parse(JSON.parse(value));
  } catch {
    return null;
  }
};
export const invokeDiscussion = async (
  context: ChatContext,
  appId: string,
  capabilityId: string,
  input: Record<string, unknown>,
  dependencies = resourceReaderDependencies,
) => {
  const session = discussionRead(context);
  return session.page(async (signal) => {
    if (context.capabilityQuery) {
      const result = await context.capabilityQuery({ appId, capabilityId, input, signal }, z.unknown());
      if (result.ok) return EnvelopeSchema.parse(result.data);
      if (result.error.status === 403 || result.error.status === 404) return null;
      throw new Error("Resource provider unavailable");
    }
    return dependencies.invoke(appId, capabilityId, input, { ...session.caller, signal });
  });
};
const loadResource = async (
  context: ChatContext,
  ref: ResourceRef,
  dependencies = resourceReaderDependencies,
  onUnavailable?: () => void,
): Promise<ResourceDecision | null> => {
  const principal = contextPrincipal(context);
  const key = accessKey(principal, ref, context.locale ?? context.caller?.locale ?? "en");
  try {
    context.caller?.signal?.throwIfAborted();
    const cached = context.capabilityQuery ? null : await redis.get(key);
    if (cached !== null) return ResourceDecisionSchema.nullable().parse(JSON.parse(cached));
    if (!context.caller || !CloudResourceRefSchema.safeParse(ref).success) return null;
    const provider = await providerFor(context, ref.type);
    if (!provider) return null;
    const type = provider.app.manifest.types.find((type) => `${provider.app.appId}.${type.localId}` === ref.type);
    if (!type?.reader) return null;
    const result = await invokeDiscussion(context, provider.app.appId, type.reader, { id: ref.id }, dependencies);
    let decision: ResourceDecision | null = null;
    if (result) {
      const view = z.object({ view: CloudResourceReaderViewSchema }).parse(result.data).view;
      if (ref.type === provider.itemType ? view.container?.ref.type !== provider.containerType : view.container !== undefined)
        throw new Error("Resource reader container mismatch");
      decision = ResourceDecisionSchema.parse({
        ...view,
        href: result.links?.find((link) => link.rel === "open")?.href,
        ...typePresentation(provider, ref.type),
      });
    }
    if (!context.capabilityQuery) {
      await redis.set(key, JSON.stringify(decision), "EX", ACCESS_TTL_SECONDS);
      await redis.set(
        authorizationKey(principal, ref),
        JSON.stringify(decision ? AuthorizationSchema.parse(decision) : null),
        "EX",
        ACCESS_TTL_SECONDS,
      );
    }
    return decision;
  } catch (error) {
    if (context.caller) {
      const session = discussionRead(context);
      session.incomplete = true;
      if (error instanceof DiscussionReadStopped) session.deferred.add(JSON.stringify(ref));
    }
    onUnavailable?.();
    return null;
  }
};
const pendingReaders = new WeakMap<CapabilityCaller, Map<string, Promise<{ resource: ResourceDecision | null; unavailable: boolean }>>>();
export const readResource = async (
  context: ChatContext,
  ref: ResourceRef,
  dependencies = resourceReaderDependencies,
  onUnavailable?: () => void,
): Promise<ResourceDecision | null> => {
  if (context.authorizedResources !== undefined)
    return context.authorizedResources.find((entry) => entry.ref.type === ref.type && entry.ref.id === ref.id)?.decision ?? null;
  if (!context.caller) return null;
  let pending = pendingReaders.get(context.caller);
  if (!pending) {
    pending = new Map();
    pendingReaders.set(context.caller, pending);
  }
  const key = accessKey(contextPrincipal(context), ref, context.locale ?? context.caller.locale ?? "en");
  let read = pending.get(key);
  if (!read) {
    read = (async () => {
      let unavailable = false;
      const resource = await loadResource(context, ref, dependencies, () => {
        unavailable = true;
      });
      return { resource, unavailable };
    })();
    pending.set(key, read);
  }
  try {
    const result = await read;
    if (result.unavailable) onUnavailable?.();
    return result.resource;
  } finally {
    if (pending.get(key) === read) pending.delete(key);
  }
};
export const resourceDeferred = (context: ChatContext, ref: ResourceRef) =>
  !!context.caller && discussionRead(context).deferred.has(JSON.stringify(ref));
export const discussionStopped = (context: ChatContext) => !!context.caller && discussionRead(context).deferred.size > 0;
export const discussionIncomplete = (context: ChatContext) => !!context.caller && discussionRead(context).incomplete;
export const readContainers = async (
  context: ChatContext,
  type: string,
  cursor?: string,
  dependencies = resourceReaderDependencies,
  query?: string,
  limit = RESOURCE_PAGE_SIZE,
) => {
  if (!context.caller || cursor === "") return { items: [], nextCursor: null };
  const provider = await providerFor(context, type, "container");
  if (!provider) return { items: [], nextCursor: null };
  const result = await invokeDiscussion(
    context,
    provider.app.appId,
    provider.containers,
    { limit, ...(cursor ? { cursor } : {}), ...(query ? { query } : {}) },
    dependencies,
  );
  if (result === null) return { items: [], nextCursor: null };
  const data = DiscussionContainersDataSchema.parse(result.data);
  if (data.items.some((entry) => entry.ref.type !== type) || data.items.length > limit || (data.next !== null && data.next === cursor))
    throw new Error("Invalid discussion container page");
  return {
    items: data.items.map((entry) => ({ ref: entry.ref, name: entry.title, ...typePresentation(provider, type) })),
    nextCursor: data.next,
  };
};
