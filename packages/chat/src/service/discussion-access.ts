import type { CapabilityExecutionContext } from "@k2b/cloud/contracts";
import { err, fail, ok } from "@k2b/cloud/server";
import type { z } from "zod";
import type { DiscussionItemSchema } from "../capability-contracts";
import { type ChatContext, messages } from "./access";
import { providerFor } from "./discussion-read";
import { readResource } from "./resource-access";

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

/** Fresh standard item and container reads under the incoming authority, sharing one bounded session. */
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
    capabilityQuery: context.query,
    caller: { authority: context.authority, signal: context.signal, locale: context.locale, requestId: context.requestId },
  };
  const t = messages(base);
  const unavailable = () => ({
    ok: false as const,
    error: { code: "PROVIDER_UNAVAILABLE", status: 503 as const, message: t.systemChatsFailed },
  });
  const notFound = () => fail({ code: "NOT_FOUND", status: 404, message: t.notFound });
  if (!context.query) return unavailable();
  let failed = false;
  const provider = await providerFor(base, item.type, "item").catch(() => {
    failed = true;
    return null;
  });
  if (failed) return unavailable();
  if (!provider) return notFound();
  const onUnavailable = () => {
    failed = true;
  };
  const decision = await readResource(base, item, undefined, onUnavailable);
  if (failed) return unavailable();
  if (!decision?.container || decision.container.ref.type !== provider.containerType) return notFound();
  const container = decision.container;
  const owner = await readResource(base, container.ref, undefined, onUnavailable);
  if (failed) return unavailable();
  if (!owner) return notFound();
  if (write && owner.permission === "read") return fail(err.forbidden(t.forbidden));
  return ok({
    item,
    container,
    decision,
    context: {
      ...base,
      authorizedResources: [
        { ref: item, decision },
        { ref: container.ref, decision: owner },
      ],
    } satisfies ChatContext,
  });
};
