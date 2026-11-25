import { type UserDirectoryEntry, UserDirectoryEntrySchema } from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Chip,
  Failed,
  FilterBar,
  Inline,
  Input,
  ListOrder,
  Menu,
  Notice,
  Pane,
  StatusRow,
  Table,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { z } from "zod";
import AccountsNav from "../AccountsNav";
import { type ListMessages, useListMessages } from "../list-messages";
import {
  isUserView,
  parseUsersAddress,
  USER_VIEW_KEYS,
  USER_VIEWS,
  USERS_PAGE_MAX,
  USERS_PER_PAGE,
  type UsersState,
  type UserView,
  userDetailHref,
  usersHref,
  usersQuery,
} from "./query";
import { inSeveralGroups, lastLoginText, type UserRow, userRows } from "./rows";

export type UsersScreenProps = {
  state: UsersState;
  page: number;
  /** The accounts of the page and how many match in all; null when the list could not be read. */
  entries: UserDirectoryEntry[] | null;
  total: number;
  /** Names of the groups the address filters by, which the server resolved. */
  groupNames: LookupItem[];
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
  /** The server's time and the person's time zone, so the server and the browser write the same dates. */
  now: string;
  timeZone: string;
  pendingRequests: number;
};

const ListResponseSchema = z.object({ users: z.array(UserDirectoryEntrySchema), pagination: z.object({ total: z.number() }) });
const GroupsResponseSchema = z.object({ groups: z.array(z.object({ id: z.string(), name: z.string() })) });

/** The groups the lookup offers and names: all groups, personal Linux groups left out, through the groups API. */
const searchGroups = async (params: Record<string, string>, signal: AbortSignal): Promise<LookupItem[]> => {
  const response = await fetch(`/api/accounts/groups?${new URLSearchParams({ scope: "all", ...params })}`, { signal });
  if (!response.ok) throw new Error(`groups ${response.status}`);
  return GroupsResponseSchema.parse(await response.json()).groups.map((group) => ({ value: group.id, label: group.name }));
};

const viewLabel = (t: ListMessages, view: UserView): string =>
  ({
    "no-passkey": t.viewNoPasskey,
    invited: t.viewInvited,
    expired: t.viewExpired,
    "inactive-admins": t.viewInactiveAdmins,
  })[view];

const statusChip = (t: ListMessages, entry: UserDirectoryEntry) =>
  entry.status === "active" ? (
    <Chip status="ok">{t.active}</Chip>
  ) : entry.status === "invited" ? (
    <Chip status="warn">{t.invited}</Chip>
  ) : (
    <Chip status="bad">{t.expired}</Chip>
  );

/** The users of this Cloud on v2: views, filter statements, sort and grouping in the address, one row per account. */
export default function UsersScreen(props: UsersScreenProps) {
  const locale = useLocale();
  const t = useListMessages();
  const query = createMemo(() =>
    usersQuery(locale(), {
      load: async (text, context) => ({
        items: await searchGroups({ search: text.trim(), per_page: String(context.limit) }, context.signal),
      }),
      resolve: async (values, context) => searchGroups({ ids: values.join(","), per_page: String(values.length) }, context.signal),
    }),
  );
  const [state, setState] = createSignal<UsersState>(props.state);
  const [page, setPage] = createSignal(props.page);
  const [entries, setEntries] = createSignal<UserDirectoryEntry[] | null>(props.entries);
  const [total, setTotal] = createSignal(props.total);
  const [now, setNow] = createSignal(new Date(props.now));
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [refreshing, setRefreshing] = createSignal(false);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const pages = () => Math.min(USERS_PAGE_MAX, Math.max(1, Math.ceil(total() / USERS_PER_PAGE)));
  const grouped = () => state().group === "member-of";
  const rows = createMemo(() => userRows(entries() ?? [], grouped(), locale()));
  const context = () => query().serialize(state()).toString();
  const href = (next: UsersState, nextPage = 1) => usersHref(query(), next, nextPage);

  let controller: AbortController | undefined;
  /** Loads the page for a state through the users API; the old rows stay until the new ones come. */
  const load = async (next: UsersState, nextPage: number) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setRefreshing(true);
    const params = query().serialize({ ...next, group: undefined });
    params.set("per_page", String(USERS_PER_PAGE));
    if (nextPage > 1) params.set("page", String(nextPage));
    try {
      const response = await fetch(`/api/accounts/users?${params}`, { signal: current.signal });
      if (!response.ok) throw new Error(`users ${response.status}`);
      const body = ListResponseSchema.parse(await response.json());
      if (current.signal.aborted) return;
      setEntries(body.users);
      setTotal(body.pagination.total);
      setNow(new Date());
    } catch {
      if (!current.signal.aborted) setEntries(null);
    } finally {
      if (controller === current) setRefreshing(false);
    }
  };

  /** The rows a state asks for: everything but the grouping, which only arranges the rows of the page. */
  const rowsOf = (value: UsersState) =>
    query()
      .serialize({ ...value, group: undefined })
      .toString();
  /** The page of the address after a history step, read before the bar reports the step. */
  let restoring: number | undefined;

  /** A new state from the bar, the search or the order. A history step restores its page; a new filter starts at 1. */
  const change = (next: UsersState) => {
    const before = state();
    setState(next);
    const restored = restoring;
    restoring = undefined;
    if (restored !== undefined) {
      setPage(restored);
      void load(next, restored);
      return;
    }
    if (rowsOf(next) === rowsOf(before)) return;
    if (page() !== 1 && !isServer) {
      setPage(1);
      const params = new URLSearchParams(location.search);
      params.delete("page");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    }
    void load(next, 1);
  };

  const search = (text: string) => {
    const next = query().set(state(), "q", text.trim());
    if (!next) return;
    const params = query().serialize(next, location.search);
    params.delete("page");
    history.pushState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    change(next);
  };

  onMount(() => {
    // capture: this runs before the bar's own listener reports the step through `change`
    const step = () => {
      restoring = parseUsersAddress(query(), new URLSearchParams(location.search)).page;
    };
    addEventListener("popstate", step, { capture: true });
    onCleanup(() => {
      controller?.abort();
      removeEventListener("popstate", step, { capture: true });
    });
  });

  const currentView = (): UserView | undefined => {
    const view = state().view;
    return isUserView(view) ? view : undefined;
  };
  const base = () => {
    const view = currentView();
    return view ? USER_VIEWS[view](query()) : query().reset();
  };
  const changed = () => query().serialize(state()).toString() !== query().serialize(base()).toString();
  const several = () => (grouped() ? inSeveralGroups(entries() ?? []) : 0);
  const person = (entry: UserDirectoryEntry) => ({
    name: entry.displayName || entry.mail || entry.uid,
    image: entry.avatarHash
      ? `/api/accounts/users/${encodeURIComponent(entry.id)}/avatar?rev=${encodeURIComponent(entry.avatarHash)}`
      : undefined,
  });
  const roleWord = (entry: UserDirectoryEntry) => ({ admin: t().admin, member: t().member, guest: t().guest })[entry.role];
  const groupWords = (entry: UserDirectoryEntry) =>
    entry.groups
      .slice(0, 3)
      .map((group) => group.name)
      .join(", ") + (entry.groupCount > 3 ? ` ${t().moreGroups({ count: entry.groupCount - 3 })}` : "");
  const login = (entry: UserDirectoryEntry) =>
    lastLoginText(entry.lastLogin, t(), { locale: locale(), timeZone: props.timeZone, now: now() });
  const groupOf = (row: UserRow) => {
    const members = rows().filter((other) => other.group?.id === row.group?.id).length;
    return {
      key: row.group?.id ?? "none",
      head: () => <Text weight="strong">{row.group?.name ?? t().noGroup}</Text>,
      meta: number(members),
      count: number(members),
    };
  };
  const lead = () => {
    const shown = entries()?.length ?? 0;
    return shown < total() || changed()
      ? t().usersOf({ count: number(shown), total: number(total()) })
      : t().usersCount({ count: number(total()) });
  };

  return (
    <Workspace
      sidebar={<AccountsNav active="users" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={
            <Tabs
              label={t().views}
              items={[
                { label: t().viewAll, href: href(query().reset()), current: currentView() === undefined },
                ...USER_VIEW_KEYS.map((view) => ({
                  label: viewLabel(t(), view),
                  href: href(USER_VIEWS[view](query())),
                  current: currentView() === view,
                })),
              ]}
            />
          }
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchUsers}
                placeholder={t().searchUsers}
                value={state().search ?? ""}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) {
                    input.value = "";
                    search("");
                  }
                }}
              />
              <Menu label={t().more} items={[{ label: t().duplicateEmails, icon: "copy", href: "/app/accounts/duplicate-emails" }]} />
              <Button variant="primary" icon="user-plus" href="/app/accounts/users/new">
                {t().newUser}
              </Button>
            </>
          }
        />
      }
      primary={{ label: t().newUser, icon: "user-plus", href: "/app/accounts/users/new" }}
    >
      <Pane
        label={t().users}
        scrollKey="accounts-users"
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              base={base()}
              icons={{
                role: "id-badge-2",
                "member-of": "users-group",
                status: "circle-dot",
                login: "login",
                passkey: "key",
                provider: "building",
              }}
              names={{ "member-of": props.groupNames }}
              timeZone={props.timeZone}
              results={t().usersCount({ count: number(total()) })}
            />
            <StatusRow
              lead={entries() ? lead() : t().loadFailed}
              loading={refreshing()}
              facts={[
                ...(several() > 0 ? [{ after: t().inSeveralGroups({ count: several() }) }] : []),
                // grouping arranges the rows of one page; with more pages, say so
                ...(grouped() && pages() > 1 ? [{ after: t().groupedOnPage }] : []),
              ]}
              filters={<ListOrder query={query()} state={state()} onChange={change} />}
            />
          </>
        }
      >
        <Show when={ignored()}>
          {(text) => (
            <Notice tone="warn" title={t().ignoredParts} actions={[{ label: t().hide, onClick: () => setIgnored(null) }]}>
              {text()}
            </Notice>
          )}
        </Show>
        <Show when={entries()} fallback={<Failed text={t().loadFailed} onRetry={() => void load(state(), page())} />}>
          <Table
            label={t().users}
            rows={rows()}
            rowKey={(row) => row.key}
            group={grouped() ? groupOf : undefined}
            open={(row) => ({ href: userDetailHref(row.entry.id, context()) })}
            empty={
              changed()
                ? { icon: "filter-off", text: t().noMatches, action: { label: t().resetFilters, icon: "filter-off", href: href(base()) } }
                : { icon: "users", text: t().noUsers }
            }
            phone={(row) => ({
              lines: [person(row.entry).name, [roleWord(row.entry), groupWords(row.entry)].filter(Boolean).join(" · ")],
              avatar: person(row.entry),
              time: login(row.entry),
              marks: statusChip(t(), row.entry),
            })}
            columns={[
              {
                title: t().name,
                width: { min: 180, default: 240 },
                cell: (row) => (
                  <Inline>
                    <Avatar {...person(row.entry)} decorative />
                    <Text weight="strong">{person(row.entry).name}</Text>
                  </Inline>
                ),
              },
              { title: t().email, width: { min: 160, default: 240 }, cell: (row) => row.entry.mail ?? "–", drop: true },
              { title: t().role, width: { min: 90, default: 110 }, cell: (row) => roleWord(row.entry), drop: true },
              { title: t().groups, width: { min: 140, default: 220 }, cell: (row) => groupWords(row.entry) || "–", drop: true },
              { title: t().status, width: { min: 110, default: 120 }, cell: (row) => statusChip(t(), row.entry) },
              {
                title: t().passkey,
                width: { min: 90, default: 110 },
                cell: (row) => (row.entry.passkey ? t().passkeyYes : t().passkeyNo),
                drop: true,
              },
              { title: t().lastActive, width: { min: 110, default: 130 }, align: "end", cell: (row) => login(row.entry) },
            ]}
          />
        </Show>
        <Show when={pages() > 1}>
          <Bar
            start={<Text type="meta">{t().pageOf({ page: page(), pages: pages() })}</Text>}
            end={
              <>
                <Button icon="chevron-left" href={href(state(), page() - 1)} disabled={page() <= 1}>
                  {t().previous}
                </Button>
                <Button href={href(state(), page() + 1)} disabled={page() >= pages()} forward>
                  {t().next}
                </Button>
              </>
            }
          />
        </Show>
      </Pane>
    </Workspace>
  );
}
