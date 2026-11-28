import { defineListQuery, field, type ListQueryStateOf } from "@k2b/ui/v2/list-query";
import type { CodeAdminCodeStatus } from "../../../code/admin";
import { type CodeAreaQuery, codeAreaHref } from "./area";
import { codeAdminMessages } from "./messages";

export const CODE_LIST_STATUSES: CodeAdminCodeStatus[] = ["active", "waiting", "paused", "draft", "deleting"];

/**
 * The list of all automations in the address: one state (`status`), one owner app or personal Code (`app`), and a
 * search over title and owner (`q`), the same parameter names as before v2. Section, open automation, version and the
 * page cursor are the page's own parameters.
 */
export const codeListQuery = (locale: string, apps: readonly { id: string; name: string }[]) => {
  const t = codeAdminMessages.resolve([locale]).t;
  return defineListQuery({
    key: "core.admin.code.list",
    fields: {
      status: field.choice({
        label: t.status,
        options: CODE_LIST_STATUSES.map((value) => ({ value, label: t.statusLabel({ s: value }) })),
        multiple: false,
        common: true,
      }),
      app: field.choice({
        label: t.app,
        options: [{ value: "person", label: t.personal }, ...apps.map((app) => ({ value: app.id, label: app.name }))],
        multiple: false,
        common: true,
      }),
    },
    search: { label: t.search },
    sort: { fixed: { field: "title", direction: "asc", label: t.sortTitle } },
    pageParams: ["sec", "id", "version", "after"],
  });
};
export type CodeListQuery = ReturnType<typeof codeListQuery>;
export type CodeListState = ListQueryStateOf<CodeListQuery>;

/** The list's address for a filter state, keeping the open automation; a new filter starts on the first page. */
export const codeListHref = (state: CodeListState, id?: string): string => {
  const status = CODE_LIST_STATUSES.find((value) => value === state.filters.status);
  const app = typeof state.filters.app === "string" && state.filters.app ? state.filters.app : undefined;
  const query: CodeAreaQuery = { sec: "code", id, status, app, q: state.search || undefined };
  return codeAreaHref(query);
};
