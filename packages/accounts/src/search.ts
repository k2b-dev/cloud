import type { CapabilityExecutionContext, CloudResourceView, UniversalSearchInput } from "@k2b/cloud/contracts";
import type { accountsAppService } from "@k2b/cloud/services";
import { err, fail, ok } from "@k2b/stdlib";

import { accountsSearchMessages } from "./search-messages";

type FoundServiceAccount = { id: string; name: string; kind: string; delegatedUserId: string | null };

/**
 * Where a found service account opens: an agent in its record, a person's own key at the person, an API key account
 * (and any other kind) in the account list searched by its name.
 */
export const serviceAccountHref = (account: FoundServiceAccount): string => {
  if (account.kind === "agent" || account.kind === "standalone") return `/app/accounts/users/${encodeURIComponent(account.id)}`;
  if (account.kind === "user_delegated" && account.delegatedUserId)
    return `/app/accounts/users/${encodeURIComponent(account.delegatedUserId)}`;
  const params = new URLSearchParams({ q: account.name });
  if (account.kind === "resource_bound") params.set("kind", "api-key");
  return `/app/accounts/users?${params}`;
};

export const searchAccounts = async (
  input: UniversalSearchInput,
  context: Pick<CapabilityExecutionContext, "actor" | "locale">,
  list: typeof accountsAppService.entity.list,
) => {
  const t = accountsSearchMessages.resolve([context.locale]).t;
  if (context.actor.kind !== "user" || !context.actor.user.roles.includes("user")) return fail(err.forbidden(t.unavailable));
  if (input.scope) return fail(err.badInput("Unsupported account search context"));
  const user = context.actor.user;
  const page = await list({
    actor: { userId: user.id, uid: user.uid, roles: user.roles, provider: user.provider },
    search: input.query,
    kinds: user.roles.includes("admin") ? ["user", "group", "service_account"] : ["group"],
    pagination: { page: 1, perPage: input.limit },
  });
  const data: CloudResourceView[] = page.items.map((item) => {
    if (item.kind === "user")
      return {
        ref: { type: "accounts.user", id: item.user.id },
        title: (item.user.displayName || item.user.mail || item.user.uid).slice(0, 500),
        preview: [item.user.uid, item.user.mail].filter(Boolean).join(" · ").slice(0, 2000),
        icon: "ti ti-user",
        priority: 4,
        links: [{ rel: "open", href: `/app/accounts/users/${encodeURIComponent(item.user.id)}` }],
      };
    if (item.kind === "group")
      return {
        ref: { type: "accounts.group", id: item.group.id },
        title: item.group.name.slice(0, 500),
        preview: (item.group.description || "").slice(0, 2000),
        icon: "ti ti-users-group",
        priority: 4,
        links: [{ rel: "open", href: `/app/accounts/groups/${encodeURIComponent(item.group.id)}` }],
      };
    return {
      ref: { type: "accounts.service-account", id: item.serviceAccount.id },
      title: item.serviceAccount.name.slice(0, 500),
      preview: item.serviceAccount.status,
      icon: "ti ti-user-key",
      priority: 4,
      links: [{ rel: "open", href: serviceAccountHref(item.serviceAccount) }],
    };
  });
  return ok({ data });
};
