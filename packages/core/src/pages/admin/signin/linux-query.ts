import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import { linuxMessages } from "../settings/_components/linux-messages";

export const LINUX_PATH = "/admin/signin/linux";

/** The accounts list of Linux identities: which accounts it shows and a search by username, in the address. */
export const linuxQuery = (locale: string) => {
  const t = linuxMessages.resolve([locale]).t;
  return defineListQuery({
    key: "core.admin.linux",
    fields: {
      scope: field.choice({
        label: t.filter,
        options: [
          { value: "ready", label: t.eligible },
          { value: "all", label: t.allAccounts },
        ],
        multiple: false,
        required: "ready",
        common: true,
      }),
    },
    search: { label: t.searchUsername },
    // The accounts come in the stable order of their keyset pages.
    sort: { fixed: { field: "id", direction: "asc", label: t.stableOrder } },
  });
};
export type LinuxQuery = ReturnType<typeof linuxQuery>;
export type LinuxState = ListQueryStateOf<LinuxQuery>;

/** The list's address with a cursor of the keyset pages. */
export const linuxHref = (query: LinuxQuery, state: LinuxState, after?: string | null) => {
  const params = query.serialize(state);
  if (after) params.set("after", after);
  const search = params.toString();
  return search ? `${LINUX_PATH}?${search}` : LINUX_PATH;
};

/**
 * Reads the address: the cursor apart from the list query. Addresses from before v2 (`search=`) lead to the same list
 * with `q=`; `redirect` is set then.
 */
export const parseLinuxAddress = (query: LinuxQuery, params: URLSearchParams) => {
  const own = new URLSearchParams(params);
  const after = own.get("after");
  own.delete("after");
  const legacy = own.get("search");
  own.delete("search");
  if (legacy !== null && !own.has("q") && legacy.trim()) own.set("q", legacy.trim());
  const { state } = query.parse(own);
  return { state, after, redirect: legacy !== null ? linuxHref(query, state, after) : null };
};
