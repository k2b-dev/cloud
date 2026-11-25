import { type AccountDirectoryEntry, AccountDirectoryEntrySchema } from "@k2b/cloud/contracts";
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
  USERS_PAGE_PATH,
  USERS_PER_PAGE,
  type UsersState,
  type UserView,
  userDetailHref,
  usersHref,
  usersQuery,
} from "./query";
import { inSeveralGroups, lastLoginText, type RowGrouping, sharedAddresses, type UserRow, userRows } from "./rows";

export type UsersScreenProps = {
  state: UsersState;
  page: number;
  /** The accounts of the page and how many match in all; null when the list could not be read. */
  entries: AccountDirectoryEntry[] | null;
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

const ListResponseSchema = z.object({ accounts: z.array(AccountDirectoryEntrySchema), pagination: z.object({ total: z.number() }) });
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
    agents: t.viewAgents,
    duplicates: t.viewDuplicates,
  })[view];

/** A state as colour, dot and word. */
const statusChip = (t: ListMessages, entry: AccountDirectoryEntry) =>
  entry.status === "active" ? (
    <Chip status="ok">{t.active}</Chip>
  ) : entry.status === "invited" ? (
    <Chip status="warn">{t.invited}</Chip>
  ) : (
    <Chip status="bad">{entry.status === "expired" ? t.expired : t.disabled}</Chip>
  );

const kindWord = (t: ListMessages, entry: AccountDirectoryEntry) =>
  ({ person: t.person, agent: t.agent, "api-key": t.apiKey })[entry.kind];

/** Each kind of service account in its own symbol and colour, so agents and API key accounts stand out among people. */
const SERVICE_LOOK = {
  agent: { icon: "robot", color: "#6d28d9" },
  "api-key": { icon: "key", color: "#0f766e" },
} as const;

/** The page of an account: a person's record, or for now the agent page, which also holds API key accounts. */
const recordHref = (entry: AccountDirectoryEntry, context: string) =>
  entry.kind === "person" ? userDetailHref(entry.id, context) : `/app/accounts/agents/${entry.id}`;

/**
 * The accounts of this Cloud on v2: people, agents and API key accounts in one list, with views, filter statements,
 * sort and grouping in the address, one row per account.
 */
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
  const [entries, setEntries] = createSignal<AccountDirectoryEntry[] | null>(props.entries);
  const [total, setTotal] = createSignal(props.total);
  const [now, setNow] = createSignal(new Date(props.now));
  const [ignored, setIgnored] = createSignal(props.ignored);
  const [refreshing, setRefreshing] = createSignal(false);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const pages = () => Math.min(USERS_PAGE_MAX, Math.max(1, Math.ceil(total() / USERS_PER_PAGE)));
  const grouping = (): RowGrouping => state().group;
  const grouped = () => grouping() !== undefined;
  const rows = createMemo(() => userRows(entries() ?? [], grouping(), locale()));
  /** The list address a row carries to the user's page, its page included, so the way back lands where it left. */
  const context = () => href(state(), page()).slice(USERS_PAGE_PATH.length + 1);
  const href = (next: UsersState, nextPage = 1) => usersHref(query(), next, nextPage);

  let controller: AbortController | undefined;
  /** Loads the page for a state through the accounts API; the old rows stay until the new ones come. */
  const load = async (next: UsersState, nextPage: number) => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setRefreshing(true);
    const params = query().serialize({ ...next, group: undefined });
    params.set("per_page", String(USERS_PER_PAGE));
    if (nextPage > 1) params.set("page", String(nextPage));
    try {
      const response = await fetch(`/api/accounts/accounts?${params}`, { signal: current.signal });
      if (!response.ok) throw new Error(`accounts ${response.status}`);
      const body = ListResponseSchema.parse(await response.json());
      if (current.signal.aborted) return;
      setEntries(body.accounts);
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
  const several = () => (grouping() === "member-of" ? inSeveralGroups(entries() ?? []) : 0);
  const shared = () => (grouping() === "mail" ? sharedAddresses(entries() ?? []) : 0);
  const avatar = (entry: AccountDirectoryEntry) => {
    const id = encodeURIComponent(entry.id);
    const rev = entry.avatarHash ? `?rev=${encodeURIComponent(entry.avatarHash)}` : "";
    if (entry.kind !== "person") return { name: entry.name, image: `/api/accounts/users/${id}/avatar${rev}` };
    // a person without a picture shows initials; a service account always has its photo or its robot
    return { name: entry.displayName || entry.mail || entry.uid, image: rev ? `/api/accounts/users/${id}/avatar${rev}` : undefined };
  };
  const roleWord = (entry: AccountDirectoryEntry) =>
    entry.kind === "person" ? { admin: t().admin, member: t().member, guest: t().guest }[entry.role] : "";
  /** What an account is in the list: a person's role, or the kind of a service account in its colour. */
  const roleCell = (entry: AccountDirectoryEntry) =>
    entry.kind === "person" ? (
      roleWord(entry)
    ) : (
      <Chip tag color={SERVICE_LOOK[entry.kind].color} icon={SERVICE_LOOK[entry.kind].icon}>
        {kindWord(t(), entry)}
      </Chip>
    );
  /** A person's first groups by name; the row says how many there are in all where these are not all of them. */
  const groupWords = (entry: AccountDirectoryEntry) =>
    entry.kind !== "person"
      ? ""
      : entry.groups
          .slice(0, 3)
          .map((group) => group.name)
          .join(", ");
  const groupCount = (entry: AccountDirectoryEntry) => (entry.kind === "person" ? entry.groupCount : 0);
  // k2b-ui gap: a cut text with a count after it that always stays visible (lanes QW/MW). Until then the count of all
  // groups leads the cell, so the "…" of a long list of names never hides it.
  const groupCell = (entry: AccountDirectoryEntry) =>
    groupCount(entry) > 3 ? (
      <>
        <Chip>{number(groupCount(entry))}</Chip> {groupWords(entry)}
      </>
    ) : (
      groupWords(entry) || "–"
    );
  const login = (entry: AccountDirectoryEntry) =>
    lastLoginText(entry.kind === "person" ? entry.lastLogin : entry.lastUsed, t(), {
      locale: locale(),
      timeZone: props.timeZone,
      now: now(),
    });
  /** The second line on the phone: a person's role and groups, a service account's kind. */
  const about = (entry: AccountDirectoryEntry) =>
    entry.kind !== "person"
      ? kindWord(t(), entry)
      : [roleWord(entry), groupCount(entry) > 3 ? t().groupsCount({ count: number(groupCount(entry)) }) : groupWords(entry)]
          .filter(Boolean)
          .join(" · ");
  const groupOf = (row: UserRow) => {
    const members = rows().filter((other) => other.group?.id === row.group?.id).length;
    return {
      key: row.group?.id ?? "none",
      head: () => <Text weight="strong">{row.group?.name ?? (grouping() === "mail" ? t().noMail : t().noGroup)}</Text>,
      meta: number(members),
      count: number(members),
    };
  };
  const lead = () => {
    const shown = entries()?.length ?? 0;
    return shown < total() || changed()
      ? t().accountsOf({ count: number(shown), total: number(total()) })
      : t().accountsCount({ count: number(total()) });
  };

  // k2b-ui gap: virtualized list (lane MW). Until it lands, the server pages the table (100 accounts a page), so its DOM
  // stays bounded however many accounts there are.
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
        label={t().accounts}
        scrollKey="accounts-users"
        status={
          <>
            <FilterBar
              query={query()}
              state={state()}
              onChange={change}
              base={base()}
              icons={{
                kind: "users",
                duplicate: "copy",
                role: "id-badge-2",
                "member-of": "users-group",
                status: "circle-dot",
                login: "login",
                passkey: "key",
                provider: "building",
              }}
              names={{ "member-of": props.groupNames }}
              timeZone={props.timeZone}
              results={t().accountsCount({ count: number(total()) })}
            />
            <StatusRow
              lead={entries() ? lead() : t().loadFailed}
              loading={refreshing()}
              facts={[
                ...(several() > 0 ? [{ after: t().inSeveralGroups({ count: several() }) }] : []),
                ...(shared() > 0 ? [{ after: t().sharedOnPage({ count: shared() }) }] : []),
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
            label={t().accounts}
            rows={rows()}
            rowKey={(row) => row.key}
            sticky
            group={grouped() ? groupOf : undefined}
            open={(row) => ({ href: recordHref(row.entry, context()) })}
            empty={
              currentView() === "agents" && !changed()
                ? { icon: "robot", text: t().noAgents }
                : changed()
                ? {
                    icon: "filter-off",
                    text: t().noAccountMatches,
                    action: { label: t().resetFilters, icon: "filter-off", href: href(base()) },
                  }
                : { icon: "users", text: t().noAccounts }
            }
            phone={(row) => ({
              lines: [avatar(row.entry).name, about(row.entry)],
              avatar: avatar(row.entry),
              time: login(row.entry),
              marks: statusChip(t(), row.entry),
            })}
            columns={[
              {
                title: t().name,
                width: { min: 180, default: 240 },
                cell: (row) => (
                  <Inline>
                    <Avatar {...avatar(row.entry)} decorative />
                    <Text weight="strong">{avatar(row.entry).name}</Text>
                  </Inline>
                ),
              },
              {
                title: t().email,
                width: { min: 160, default: 240 },
                // the account name and who manages it tell apart two accounts on one address
                cell: (row) =>
                  row.entry.kind === "person"
                    ? { lines: [row.entry.mail || "–", `${row.entry.uid} · ${row.entry.provider === "ipa" ? "FreeIPA" : t().local}`] }
                    : "–",
                drop: true,
              },
              { title: t().role, width: { min: 100, default: 116 }, cell: (row) => roleCell(row.entry), drop: true },
              { title: t().groups, width: { min: 140, default: 220 }, cell: (row) => groupCell(row.entry), drop: true },
              { title: t().status, width: { min: 110, default: 120 }, cell: (row) => statusChip(t(), row.entry) },
              {
                title: t().passkey,
                width: { min: 90, default: 110 },
                cell: (row) => (row.entry.kind !== "person" ? "–" : row.entry.passkey ? t().passkeyYes : t().passkeyNo),
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
