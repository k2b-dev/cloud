import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/cloud/server";
import { z } from "zod";
import type { DiscussionItemSchema } from "../capability-contracts";
import { type ChatContext, messages } from "./access";
import { ContainerRefSchema, type ResourceDecision } from "./resource-access";

const OwnerReadSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  kind: z.enum(["task", "event"]).optional(),
  spaceId: z.string().optional(),
  notebookId: z.string().optional(),
  completedAt: z.string().nullable().optional(),
  container: z.object({ ref: ContainerRefSchema, name: z.string(), permission: z.enum(["read", "write", "admin"]) }),
});

/** Check the credential ceiling before looking up any message or owner. */
export const checkDiscussionCredentialScope = (context: CapabilityExecutionContext, write = false) => {
  const scopes =
    context.actor.kind === "service_account"
      ? context.actor.scopes
      : context.authority?.credentialKind === "oauth" || context.actor.delegation?.credentialKind === "oauth"
        ? (context.authority?.scopes ?? [])
        : undefined;
  if (scopes && !scopes.some((scope) => scope === "admin" || scope === "write" || (!write && scope === "read")))
    return fail(err.forbidden(messages(context).forbidden));
  return ok(scopes);
};

/** One fresh child query, under the incoming authority. No interactive credential or cache fallback. */
export const authorizeDiscussion = async (
  item: z.infer<typeof DiscussionItemSchema>,
  context: CapabilityExecutionContext,
  write = false,
) => {
  const scope = checkDiscussionCredentialScope(context, write);
  if (!scope.ok) return scope;
  const base: ChatContext = {
    actor: context.actor,
    accessSubject: context.accessSubject,
    credentialScopes: scope.data,
    locale: context.locale,
    requestId: context.requestId,
    via: context.via ?? null,
  };
  const t = messages(base);
  const unavailable = () => ({
    ok: false as const,
    error: { code: "PROVIDER_UNAVAILABLE", status: 503 as const, message: t.systemChatsFailed },
  });
  if (!context.query) return unavailable();
  const result = await context
    .query(
      {
        appId: item.type === "spaces.item" ? "spaces" : "notebooks",
        capabilityId: item.type === "spaces.item" ? "item.read" : "note.read",
        input: { id: item.id },
        signal: context.signal,
      },
      OwnerReadSchema,
    )
    .catch(() => null);
  if (result === null) return unavailable();
  if (!result.ok) {
    const status = result.error.status;
    return status === 403 || status === 404 ? fail({ code: "NOT_FOUND", status: 404, message: t.notFound }) : unavailable();
  }
  const data = result.data.data;
  const container = data.container;
  const spaces = item.type === "spaces.item";
  if (
    data.id !== item.id ||
    container.ref.type !== (spaces ? "spaces.space" : "notebooks.notebook") ||
    container.ref.id !== (spaces ? data.spaceId : data.notebookId) ||
    (spaces && !data.kind)
  )
    return unavailable();
  if (write && container.permission === "read") return fail(err.forbidden(t.forbidden));
  const decision: ResourceDecision = {
    permission: "read",
    name: data.title,
    description: data.description ?? null,
    href: result.data.links?.find((link) => link.rel === "open")?.href ?? "",
    container: container.ref,
    kind: spaces ? data.kind! : "note",
    status: null,
    done: data.completedAt != null,
  };
  const owner: ResourceDecision = {
    permission: container.permission,
    name: container.name,
    description: null,
    href: "",
    container: null,
    kind: null,
    status: null,
    done: false,
  };
  return ok({
    item,
    container,
    context: {
      ...base,
      authorizedResources: [
        { ref: item, decision },
        { ref: container.ref, decision: owner },
      ],
    } satisfies ChatContext,
  });
};
