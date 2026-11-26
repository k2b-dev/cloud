import { type AccountDirectoryEntry, AccountDirectoryEntrySchema, type AccountDirectorySummary } from "@k2b/cloud/contracts";
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
  Mark,
  Notice,
  Pane,
  StatusRow,
  Table,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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
  /** What matters today over all accounts, for the first row; null when it could not be read. */
  summary: AccountDirectorySummary | null;
  /** Names of the groups the address filters by, which the server resolved. */
  groupNames: LookupItem[];
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
  /** The server's time and the person's time zone, so the server and the browser write the same dates. */
  now: string;
  timeZone: string;
  pendingRequests: number;
};

/** How many of a person's groups show as faces before "+n". */
const GROUP_FACES = 3;

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

const kindWord = (t: ListMessages, entry: AccountDirectoryEntry) => ({ person: t.person, agent: t.agent, "api-key": t.apiKey })[entry.kind];

/** Each kind of service account in its own symbol and colour, so agents and API key accounts stand out among people. */
const SERVICE_LOOK = {
  agent: { icon: "robot", color: "#6d28d9" },
  "api-key": { icon: "key", color: "#0f766e" },
} as const;

/** The picture of an account's own: a person's or an agent's avatar, through the avatar route of Accounts. */
const pictureOf = (entry: AccountDirectoryEntry) =>
  entry.avatarHash ? `/api/accounts/users/${encodeURIComponent(entry.id)}/avatar?rev=${encodeURIComponent(entry.avatarHash)}` : undefined;

/**
 * Where an account opens until the one account record lands: a person's page, an agent's page, and for an API key
 * account (which never had a page of its own) its keys on the API key page, where administrators saw it before.
 */
const recordHref = (entry: AccountDirectoryEntry, context: string) =>
  entry.kind === "person"
    ? userDetailHref(entry.id, context)
    : entry.kind === "agent"
      ? `/app/accounts/agents/${entry.id}`
      : `/app/accounts/api-keys?${new URLSearchParams({ search: entry.name, kind: "resource_bound", automatic: "1" })}`;

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
  const nameOf = (entry: AccountDirectoryEntry) => (entry.kind === "person" ? entry.displayName || entry.mail || entry.uid : entry.name);
  /** A person's face: their picture, or initials. */
  const avatar = (entry: AccountDirectoryEntry) => ({ name: nameOf(entry), image: pictureOf(entry) });
  /** A service account's sign: its kind's symbol in the kind's colour, or the agent's own picture over it. */
  const mark = (entry: AccountDirectoryEntry & { kind: "agent" | "api-key" }) => ({ ...SERVICE_LOOK[entry.kind], image: pictureOf(entry) });
  /** Every row leads with its sign: a person's avatar, an agent's robot, an API key account's key. */
  const face = (entry: AccountDirectoryEntry) =>
    entry.kind === "person" ? <Avatar {...avatar(entry)} decorative /> : <Mark {...mark(entry)} />;
  const roleWord = (entry: AccountDirectoryEntry) =>
    entry.kind === "person" ? { admin: t().admin, member: t().member, guest: t().guest }[entry.role] : "";
  /** What an account is in the list: a person's role, or the kind of a service account (its mark shows it too). */
  const roleCell = (entry: AccountDirectoryEntry) => (entry.kind === "person" ? roleWord(entry) : kindWord(t(), entry));
  /** A person's first groups by name, as many as their stack shows. */
  const groupWords = (entry: AccountDirectoryEntry) =>
    entry.kind !== "person"
      ? ""
      : entry.groups
          .slice(0, GROUP_FACES)
          .map((group) => group.name)
          .join(", ");
  const groupCount = (entry: AccountDirectoryEntry) => (entry.kind === "person" ? entry.groupCount : 0);
  /**
   * A person's groups as a stack of faces with "+n" for the rest, then the names of those shown. The stack stands
   * first, so the "…" of long names never hides how many groups there are.
   */
  const groupCell = (entry: AccountDirectoryEntry) =>
    entry.kind !== "person" || entry.groups.length === 0 ? (
      "–"
    ) : (
      <>
        <Avatar.Stack
          people={entry.groups.map((group) => ({ name: group.name }))}
          max={GROUP_FACES}
          label={t().groupsCount({ count: number(entry.groupCount) })}
        />{" "}
        {groupWords(entry)}
      </>
    );
  const login = (entry: AccountDirectoryEntry) =>
    lastLoginText(entry.kind === "person" ? entry.lastLogin : entry.lastUsed, t(), {
      locale: locale(),
      timeZone: props.timeZone,
      now: now(),
    });
  /** The second line on the phone: a person's role and groups, a service account's kind (and an API key's app). */
  const about = (entry: AccountDirectoryEntry) =>
    entry.kind !== "person"
      ? [kindWord(t(), entry), entry.resource?.appId].filter(Boolean).join(" · ")
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
  /** Whether the list holds people (then their columns show) or only service accounts (then they would be all "–"). */
  const withPeople = () => state().filters.kind?.includes("person") ?? true;
  const withKeys = () => state().filters.kind?.includes("api-key") ?? true;
  const resourceWords = (resource: { appId: string; type: string }) => `${resource.appId} · ${resource.type}`;
  /** How many accounts the list shows: a count, so it stands quiet beside the statement of the day. */
  const counted = () => {
    const shown = entries()?.length ?? 0;
    return shown < total() || changed()
      ? t().accountsOf({ count: number(shown), total: number(total()) })
      : t().accountsCount({ count: number(total()) });
  };
  /** The first row says what matters today: who signed in, then what needs a hand as chips that open their view. */
  const today = () => (props.summary ? t().signedInToday({ count: props.summary.signedInToday }) : counted());
  const todo = () => {
    const summary = props.summary;
    if (!summary) return [];
    const viewHref = (view: UserView) => href(USER_VIEWS[view](query()));
    return [
      { count: summary.invited, status: "warn" as const, label: t().invitedCount, href: viewHref("invited") },
      { count: summary.expired, status: "bad" as const, label: t().expiredCount, href: viewHref("expired") },
      { count: summary.withoutPasskey, status: "warn" as const, label: t().withoutPasskeyCount, href: viewHref("no-passkey") },
      { count: summary.sharedAddresses, status: "warn" as const, label: t().sharedAddressesCount, href: viewHref("duplicates") },
    ].filter((item) => item.count > 0);
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
            {/* k2b-ui gap: a head of at most two full-width rows (PR #4208 part 2 joins filters, count and order). */}
            <StatusRow
              lead={entries() ? today() : t().loadFailed}
              loading={refreshing()}
              facts={[
                ...(props.summary && entries() ? [{ after: counted() }] : []),
                ...(several() > 0 ? [{ after: t().inSeveralGroups({ count: several() }) }] : []),
                ...(shared() > 0 ? [{ after: t().sharedOnPage({ count: shared() }) }] : []),
                // grouping arranges the rows of one page; with more pages, say so
                ...(grouped() && pages() > 1 ? [{ after: t().groupedOnPage }] : []),
              ]}
              filters={
                <>
                  <For each={todo()}>
                    {(item) => (
                      <Chip status={item.status} href={item.href}>
                        {item.label({ count: item.count })}
                      </Chip>
                    )}
                  </For>
                  <ListOrder query={query()} state={state()} onChange={change} />
                </>
              }
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
              lines: [nameOf(row.entry), about(row.entry)],
              ...(row.entry.kind === "person" ? { avatar: avatar(row.entry) } : { mark: mark(row.entry) }),
              time: login(row.entry),
              marks: statusChip(t(), row.entry),
            })}
            columns={[
              {
                title: t().name,
                width: { min: 180, default: 220 },
                cell: (row) => (
                  <Inline>
                    {face(row.entry)}
                    <Text weight="strong">{nameOf(row.entry)}</Text>
                  </Inline>
                ),
              },
              ...(withPeople()
                ? [
                    {
                      title: t().email,
                      width: { min: 160, default: 220 },
                      // the account name and who manages it tell apart two accounts on one address
                      cell: (row: UserRow) =>
                        row.entry.kind === "person"
                          ? {
                              lines: [
                                row.entry.mail || "–",
                                `${row.entry.uid} · ${row.entry.provider === "ipa" ? "FreeIPA" : t().local}`,
                              ] as const,
                            }
                          : row.entry.resource
                            ? { lines: ["–", resourceWords(row.entry.resource)] as const }
                            : "–",
                      drop: true,
                    },
                  ]
                : withKeys()
                  ? [
                      {
                        title: t().app,
                        width: { min: 160, default: 220 },
                        cell: (row: UserRow) =>
                          row.entry.kind !== "person" && row.entry.resource ? resourceWords(row.entry.resource) : "–",
                        drop: true,
                      },
                    ]
                  : []),
              {
                title: withPeople() ? t().role : t().kind,
                width: { min: 90, default: 100 },
                cell: (row: UserRow) => roleCell(row.entry),
                drop: true,
              },
              ...(withPeople()
                ? [{ title: t().groups, width: { min: 140, default: 200 }, cell: (row: UserRow) => groupCell(row.entry), drop: true }]
                : []),
              { title: t().status, width: { min: 110, default: 116 }, cell: (row: UserRow) => statusChip(t(), row.entry) },
              ...(withPeople()
                ? [
                    {
                      title: t().passkey,
                      width: { min: 90, default: 100 },
                      cell: (row: UserRow) => (row.entry.kind !== "person" ? "–" : row.entry.passkey ? t().passkeyYes : t().passkeyNo),
                      drop: true,
                    },
                  ]
                : []),
              {
                title: t().lastActive,
                width: { min: 110, default: 120 },
                align: "end" as const,
                cell: (row: UserRow) => login(row.entry),
              },
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
