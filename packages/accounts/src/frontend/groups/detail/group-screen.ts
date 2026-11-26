import type { LookupItem, LookupLoadResult } from "@k2b/ui/v2/list-query";
import { z } from "zod";

export type GroupTab = "members" | "managers" | "member-of" | "relations";
export type EntityType = "user" | "group" | "service_account";

/** One entry of a tab as the server words it: the name, its second line, and where it leads for this viewer. */
export type GroupMember = {
  /** `<type>:<id>`, unique in the list. */
  key: string;
  kind: "user" | "group" | "agent" | "user-bound" | "resource-bound";
  id: string;
  name: string;
  /** uid and email of a user, a group's description, the app of a bound account. */
  line: string | null;
  /** A user's account type. */
  profile?: "user" | "guest";
  /** Where a group is managed. */
  provider?: "ipa" | "local";
  /** Stands in the group itself, not through a contained group; only such entries can be removed here. */
  direct: boolean;
  href: string | null;
  /** The picture of a user or an agent. */
  image?: string;
};

/** A face: a person, an agent with its robot, or a group (which shows its mark). */
export type GroupPerson = { name: string; image?: string };

/** One change of the group, as a sentence: who did what, to whom, when. */
export type GroupActivity = {
  id: string;
  action: "create" | "update" | "posix" | "member.add" | "member.remove" | "manager.add" | "manager.remove";
  actor: GroupPerson;
  subject: { kind: "user" | "group" | "agent"; name: string } | null;
  /** Formatted on the server, relative to the time of the answer. */
  time: string;
};

/** The entity a list key names, as the membership API takes it. */
export const entityOf = (key: string): { type: EntityType; id: string } | null => {
  const at = key.indexOf(":");
  const type = key.slice(0, at);
  const id = key.slice(at + 1);
  return at > 0 && id && (type === "user" || type === "group" || type === "service_account") ? { type, id } : null;
};

const ListedEntitiesSchema = z.object({
  items: z.array(
    z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("user"),
        user: z.object({ id: z.string(), uid: z.string(), displayName: z.string(), mail: z.string().nullable() }),
      }),
      z.object({ kind: z.literal("group"), group: z.object({ id: z.string(), name: z.string(), description: z.string().nullable() }) }),
      z.object({ kind: z.literal("service_account"), serviceAccount: z.object({ id: z.string(), name: z.string() }) }),
    ]),
  ),
});

/** What the add dialogs search: kinds, one provider, and who is already there. */
export type EntitySearch = {
  kinds: EntityType[];
  provider?: "ipa" | "local";
  exclude: { users: readonly string[]; groups: readonly string[]; agents: readonly string[] };
};

/**
 * Loads the Accounts directory for a lookup with the viewer's own visibility: the same request the directory search
 * has always made (kinds, one provider, active agents only, who is already there left out). Only agents can join a
 * group as machines; other service accounts never show.
 */
export const loadEntities =
  (search: EntitySearch, words: { agent: string }) =>
  async (query: string, context: { signal: AbortSignal; limit: number }): Promise<LookupLoadResult> => {
    const url = new URL("/api/accounts/entities", window.location.origin);
    if (query) url.searchParams.set("search", query);
    url.searchParams.set("kinds", search.kinds.join(","));
    url.searchParams.set("per_page", String(context.limit));
    if (search.provider) url.searchParams.set("provider", search.provider);
    if (search.exclude.users.length) url.searchParams.set("exclude_user_ids", search.exclude.users.join(","));
    if (search.exclude.groups.length) url.searchParams.set("exclude_group_ids", search.exclude.groups.join(","));
    if (search.exclude.agents.length) url.searchParams.set("exclude_service_account_ids", search.exclude.agents.join(","));
    if (search.kinds.includes("service_account")) {
      url.searchParams.set("service_account_kinds", "standalone,agent");
      url.searchParams.set("service_account_status", "active");
    }
    const response = await fetch(url, { signal: context.signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { items } = ListedEntitiesSchema.parse(await response.json());
    return {
      items: items.map(
        (item): LookupItem =>
          item.kind === "user"
            ? {
                value: `user:${item.user.id}`,
                label: item.user.displayName || item.user.uid,
                meta: item.user.mail ? `${item.user.uid} · ${item.user.mail}` : item.user.uid,
              }
            : item.kind === "group"
              ? {
                  value: `group:${item.group.id}`,
                  // k2b-ui gap (platform): groupDisplayName lives in the `@k2b/cloud/shared` barrel, which pulls ~1 MB into an island;
                  // the lookup shows the stored name, which is also what people type.
                  label: item.group.name,
                  meta: item.group.description ?? undefined,
                }
              : { value: `service_account:${item.serviceAccount.id}`, label: item.serviceAccount.name, meta: words.agent },
      ),
    };
  };
