import type { LookupItem, LookupLoadResult } from "@k2b/ui/v2/list-query";
import { z } from "zod";

const EntitiesSchema = z.object({
  items: z.array(
    z.object({
      kind: z.string(),
      user: z.object({ id: z.string(), uid: z.string(), displayName: z.string(), mail: z.string().nullable().optional() }).optional(),
      group: z.object({ id: z.string(), name: z.string(), provider: z.string().optional() }).optional(),
      serviceAccount: z.object({ id: z.string(), name: z.string() }).optional(),
    }),
  ),
});

/** Searches or names identities through the directory API the v1 identity search used (`/api/accounts/entities`). */
const entities = async (params: Record<string, string>, signal: AbortSignal): Promise<LookupItem[]> => {
  const response = await fetch(`/api/accounts/entities?${new URLSearchParams(params)}`, { signal });
  if (!response.ok) throw new Error(`entities ${response.status}`);
  return EntitiesSchema.parse(await response.json()).items.flatMap((item) =>
    item.user
      ? [{ value: item.user.id, label: item.user.displayName || item.user.uid, meta: item.user.mail || item.user.uid }]
      : item.group
        ? [{ value: item.group.id, label: item.group.name, meta: item.group.provider === "ipa" ? "FreeIPA" : undefined }]
        : item.serviceAccount
          ? [{ value: item.serviceAccount.id, label: item.serviceAccount.name }]
          : [],
  );
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EntityKind = "user" | "group" | "service_account";
const idParams: Record<EntityKind, string> = { user: "user_ids", group: "group_ids", service_account: "service_account_ids" };

/**
 * A lookup over some kinds of identities: `load` searches them (from two characters, as the v1 search), `resolve` names
 * chosen IDs; a chosen value that is no ID (an old link's user name) names itself.
 */
export const entityLookup = (kinds: readonly EntityKind[]) => ({
  load: async (text: string, context: { signal: AbortSignal; limit: number }): Promise<LookupLoadResult> => ({
    items: await entities({ search: text.trim(), kinds: kinds.join(","), per_page: String(context.limit) }, context.signal),
  }),
  resolve: async (values: readonly string[], context: { signal: AbortSignal }): Promise<readonly LookupItem[]> => {
    const ids = values.filter((value) => UUID.test(value)).join(",");
    const named = ids
      ? await entities(
          {
            kinds: kinds.join(","),
            per_page: String(values.length * kinds.length),
            ...Object.fromEntries(kinds.map((kind) => [idParams[kind], ids])),
          },
          context.signal,
        )
      : [];
    return values.map((value) => named.find((item) => item.value === value) ?? { value, label: value });
  },
});
