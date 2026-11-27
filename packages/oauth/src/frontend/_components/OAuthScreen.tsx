import { formatDate, groupDisplayName } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Band,
  Bar,
  Button,
  Canvas,
  Cells,
  Check,
  Chip,
  Choice,
  confirm,
  Dialog,
  Empty,
  Facts,
  Field,
  Icon,
  Inline,
  Input,
  Lookup,
  Mark,
  Menu,
  type NavProps,
  Notice,
  Pane,
  RecordHead,
  Row,
  Section,
  Spark,
  Table,
  Tabs,
  Text,
  useToast,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { OAuthClient, OAuthScope } from "@/contracts";
import type { ClientConnections, ConnectedPerson, ConnectionFigures } from "../../service/connections";
import { CLIENTS_PER_PAGE } from "../clients-page";
import { oauthMessages } from "../messages";
import { clientEditorUpdate, clientEditorValues, type ProfileChoice, profileChoice, profilesForChoice } from "./client-editor";
import { DayBars } from "./DayBars";
import { clientMark, GROUP_MARK } from "./kind-marks";

/** One client as the list shows it: the stored client and its date in the person's words. */
export type ClientRow = OAuthClient & { created: string };

export type OAuthTab = "clients" | "endpoints";

export type OAuthScreenProps = {
  nav: NavProps;
  /** The public address of this Cloud, for the endpoints. */
  baseUrl: string;
  /** The clients, or the endpoints and claims an application needs (`tab=endpoints`). */
  tab: OAuthTab;
  search: string;
  paging: { page: number; pages: number };
  clients: ClientRow[];
  figures: { total: number; public: number; dynamic: number };
  /** All connections: active, people, new per day, unused clients (`oauthService.client.connectionFigures`). */
  activity: ConnectionFigures;
  /**
   * The colour of OAuth itself: its figures and histories carry it, while the shell around shows the colour of the area
   * the page stands in (Administration).
   */
  accent: string;
  /** The people connected with the open client, most recently used first; null while none is open. */
  connectedPeople: { total: number; people: ConnectedPerson[] } | null;
  /** The connections of the listed and the open client, by `clientId`. */
  connections: Record<string, ClientConnections>;
  /** The client open beside the list (`client=<id>`), read on its own; `found` is null when it is gone. */
  open: { id: string; found: ClientRow | null } | null;
};

const PATH = "/admin/oauth";

/** Every scope a managed client may request, in the order the editor offers them, with its sign. */
const SCOPES = [
  { id: "openid", icon: "fingerprint" },
  { id: "profile", icon: "id-badge-2" },
  { id: "email", icon: "mail" },
  { id: "groups", icon: "users-group" },
  { id: "offline_access", icon: "refresh" },
  { id: "read", icon: "eye" },
  { id: "write", icon: "pencil" },
  { id: "admin", icon: "shield-lock" },
] as const satisfies readonly { id: OAuthScope; icon: string }[];

type Draft = {
  name: string;
  description: string;
  redirectUris: string;
  logoutUri: string;
  isPublic: boolean;
  allowDeviceGrant: boolean;
  profiles: ProfileChoice;
  specific: boolean;
  /** The chosen people and groups as `user:<id>` and `group:<id>`. */
  principals: string[];
  scopes: OAuthScope[];
};

const draftOf = (client: OAuthClient | null): Draft => {
  const values = clientEditorValues(client ?? undefined);
  return {
    name: client?.name ?? "",
    description: values.description,
    redirectUris: values.redirectUris,
    logoutUri: values.logoutUri,
    isPublic: client?.isPublic ?? false,
    allowDeviceGrant: values.allowDeviceGrant,
    profiles: profileChoice(values.allowedProfiles),
    specific: values.specific,
    principals: [...values.allowedUserIds.map((id) => `user:${id}`), ...values.allowedGroupIds.map((id) => `group:${id}`)],
    scopes: [...values.scopes],
  };
};

/**
 * OAuth on v2: the clients that sign people in with Cloud, one open beside the list with its deeds, and the endpoints
 * an application needs. A client's secret is shown once, when it is made or renewed.
 */
export default function OAuthScreen(props: OAuthScreenProps) {
  const locale = useLocale();
  const t = () => oauthMessages.resolve([locale()]).t;
  const toast = useToast();
  const number = (value: number) => value.toLocaleString(locale());

  /** The address of this view with some parameters changed; an open client closes unless it is named. */
  const href = (change: { tab?: OAuthTab; search?: string; page?: number; client?: string | null }) => {
    const params = new URLSearchParams();
    const tab = change.tab ?? props.tab;
    if (tab !== "clients") params.set("tab", tab);
    const search = change.search ?? props.search;
    if (tab === "clients" && search) params.set("search", search);
    const page = change.page ?? (change.tab || change.search !== undefined ? 1 : props.paging.page);
    if (tab === "clients" && page > 1) params.set("page", String(page));
    if (change.client) params.set("client", change.client);
    const text = params.toString();
    return text ? `${PATH}?${text}` : PATH;
  };
  const list = () => href({ client: null });

  const profileLabel = (client: OAuthClient) =>
    ({ user: t().fullUsersOnly, everybody: t().everybody, guest: t().guestsOnly, none: t().noUserProfiles })[
      profileChoice(client.allowedProfiles)
    ];
  const scopeLabel = (scope: OAuthScope) =>
    ({
      openid: "OpenID",
      profile: t().profileScopeLabel,
      email: t().emailScopeLabel,
      groups: t().groupsScopeLabel,
      offline_access: t().offlineAccess,
      read: t().read,
      write: t().write,
      admin: t().admin,
    })[scope];

  /** The mark of a client's kind, the same in the list, the open client and every dialog. */
  const markOf = (client: OAuthClient) => clientMark(client);
  /** The one neutral badge of a client that is not the usual: brought by Cloud, registered by itself, a service, a device. */
  const badge = (client: OAuthClient) =>
    client.registrationKind === "first_party"
      ? t().firstParty
      : client.registrationKind === "dynamic"
        ? t().selfRegisteredBadge
        : client.serviceAccountId
          ? t().serviceAccount
          : client.isPublic && client.allowDeviceGrant
            ? t().deviceBadge
            : undefined;
  const NO_CONNECTIONS: ClientConnections = { active: 0, peopleCount: 0, people: [], perDay: [], lastUsedAt: null };
  const connectionsOf = (client: OAuthClient) => props.connections[client.clientId] ?? NO_CONNECTIONS;
  const DAY = 24 * 60 * 60 * 1000;
  /** A client that can keep connections and was not used for 30 days. */
  const unused = (client: OAuthClient) => {
    if (!client.scopes.includes("offline_access") || client.serviceAccountId) return false;
    const last = connectionsOf(client).lastUsedAt ?? client.createdAt;
    return Date.now() - Date.parse(last) > 30 * DAY;
  };
  /** A moment relative to now in its short form ("vor 3 Min."), as a list reads it; older than a week its date. */
  const ago = (iso: string) => {
    const diff = Date.parse(iso) - Date.now();
    const short = new Intl.RelativeTimeFormat(locale(), { numeric: "auto", style: "short" });
    const minutes = Math.round(diff / 60_000);
    if (Math.abs(minutes) < 60) return short.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return short.format(hours, "hour");
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 7) return short.format(days, "day");
    return shortDate(iso);
  };
  const dayAxis = (days: number): [string, string, string] => {
    const day = (back: number) => shortDate(new Date(Date.now() - back * 24 * 60 * 60 * 1000).toISOString());
    return [day(days - 1), day(Math.floor((days - 1) / 2)), t().today];
  };
  const NAME_IN_LINE = 32;
  const inLine = (name: string) => {
    const graphemes = [...new Intl.Segmenter(locale(), { granularity: "grapheme" }).segment(name)].map((part) => part.segment);
    return graphemes.length > NAME_IN_LINE
      ? `${graphemes
          .slice(0, NAME_IN_LINE - 1)
          .join("")
          .trimEnd()}…`
      : name;
  };
  const shortDate = (iso: string) => new Intl.DateTimeFormat(locale(), { day: "2-digit", month: "2-digit" }).format(new Date(iso));
  const lastUse = (client: OAuthClient) => {
    const last = connectionsOf(client).lastUsedAt;
    return last ? ago(last) : "–";
  };
  /** The spark's words: what the bars say, for a person who cannot see them. */
  const trendWords = (name: string, perDay: readonly number[]) =>
    t().newPerDayWords({ name, total: perDay.reduce((sum, count) => sum + count, 0), today: perDay.at(-1) ?? 0 });
  /** A client's kind in words: brought by Cloud, or how it signs in. */
  const kindLine = (client: OAuthClient) =>
    client.registrationKind === "first_party"
      ? t().firstParty
      : client.registrationKind === "dynamic"
        ? t().dynamic
        : client.isPublic
          ? t().public
          : t().confidential;
  /** The second line of every row: the kind, then what the client is for or where it lives. */
  const secondLine = (client: OAuthClient) =>
    [
      badge(client) ?? kindLine(client),
      // an unused client says only since when; its chip says the rest, so the row keeps two lines
      unused(client)
        ? undefined
        : client.serviceAccountId
          ? t().serviceAccountNoPeople
          : connectionsOf(client).active === 0
            ? t().nobodyConnectedLong
            : t().connectedCount({ count: connectionsOf(client).active }),
      lastUse(client),
    ]
      .filter(Boolean)
      .join(" · ");
  const connected = () => new Set((props.connectedPeople?.people ?? []).map((person) => person.userId));
  /** A client no profile may use: said plainly, it is a choice, not a failure. */
  const nobodyMay = (client: OAuthClient) => profileChoice(client.allowedProfiles) === "none" && client.accessMode !== "specific";
  /** A client unused for 30 days: a warn dot with its words, no pill. */
  const unusedMark = (words: string) => <Text tone="warn">{`● ${words}`}</Text>;

  // ── Directory: people and groups for "only these" ─────────────────────────────────────────────────────────────
  const loadPrincipals = async (text: string, context: { signal: AbortSignal; limit: number }) => {
    const url = new URL("/api/accounts/entities", location.origin);
    url.searchParams.set("search", text);
    url.searchParams.set("kinds", "user,group");
    url.searchParams.set("per_page", String(context.limit));
    const response = await fetch(url, { credentials: "same-origin", signal: context.signal });
    if (!response.ok) throw new Error(response.statusText);
    const data: {
      items?: { kind: string; user?: { id: string; uid: string; displayName: string | null }; group?: { id: string; name: string } }[];
    } = await response.json();
    return {
      items: (data.items ?? []).flatMap((item): LookupItem[] =>
        item.kind === "user" && item.user
          ? [{ value: `user:${item.user.id}`, label: item.user.displayName || item.user.uid, meta: t().user }]
          : item.kind === "group" && item.group
            ? [{ value: `group:${item.group.id}`, label: groupDisplayName(item.group.name, locale()), meta: t().group }]
            : [],
      ),
    };
  };
  const knownPrincipals = (client: OAuthClient | null): LookupItem[] => [
    ...(client?.accessUsers ?? []).map((user) => ({ value: `user:${user.id}`, label: user.displayName || user.uid, meta: t().user })),
    ...(client?.accessGroups ?? []).map((group) => ({
      value: `group:${group.id}`,
      label: groupDisplayName(group.name, locale()),
      meta: t().group,
    })),
  ];

  // ── Create and edit: one dialog ───────────────────────────────────────────────────────────────────────────────
  const [editing, setEditing] = createSignal<ClientRow | "new" | null>(null);
  const [draft, setDraft] = createSignal<Draft>(draftOf(null));
  const [failure, setFailure] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  /** A secret shown once: after creating a client or renewing its secret. */
  const [secret, setSecret] = createSignal<{ title: string; clientId: string | null; value: string | null; reload: boolean } | null>(null);
  const change = (values: Partial<Draft>) => setDraft({ ...draft(), ...values });
  const start = (client: ClientRow | "new") => {
    setDraft(draftOf(client === "new" ? null : client));
    setFailure(null);
    setEditing(client);
  };
  const editingClient = () => {
    const target = editing();
    return target && target !== "new" ? target : null;
  };
  const canSave = () => (editing() !== "new" || draft().name.trim().length > 0) && (!draft().specific || draft().principals.length > 0);
  const save = async () => {
    const target = editing();
    if (!target || !canSave() || busy()) return;
    const values = draft();
    const ids = (kind: "user" | "group") =>
      values.principals.filter((value) => value.startsWith(`${kind}:`)).map((value) => value.slice(kind.length + 1));
    const common = clientEditorUpdate({
      description: values.description,
      redirectUris: values.redirectUris,
      logoutUri: values.logoutUri,
      scopes: values.scopes,
      allowedProfiles: profilesForChoice(values.profiles),
      specific: values.specific,
      allowedUserIds: ids("user"),
      allowedGroupIds: ids("group"),
      allowDeviceGrant: values.isPublic && values.allowDeviceGrant,
    });
    setBusy(true);
    // a store that refuses names it; a lost connection is "not saved", never a browser's own error text
    const response = await (target === "new"
      ? apiClient.index.$post({
          json: {
            ...common,
            description: common.description ?? undefined,
            logoutUri: common.logoutUri ?? undefined,
            name: values.name.trim(),
            audiences: ["cloud"],
            isPublic: values.isPublic,
          },
        })
      : apiClient[":id"].$put({ param: { id: target.id }, json: common })
    ).catch(() => null);
    setBusy(false);
    if (!response) return setFailure(t().notSaved);
    if (!response.ok) return setFailure(target === "new" ? t().failedCreate : t().failedUpdate);
    setEditing(null);
    if (target !== "new") return location.reload();
    const body = await response.json();
    if ("clientId" in body) {
      setSecret({
        title: t().clientCreated,
        clientId: body.clientId,
        value: "clientSecret" in body ? body.clientSecret || null : null,
        reload: true,
      });
      // the list behind the dialog reads this page again from the same service, so the new client stands with all
      // its data; the secret stays in the dialog until it is closed
      await refreshList();
    }
  };

  // ── The list as the server has it now ─────────────────────────────────────────────────────────────────────────
  const [listed, setListed] = createSignal<{ clients: ClientRow[]; total: number } | null>(null);
  const rows = () => listed()?.clients ?? props.clients;
  const total = () => listed()?.total ?? props.figures.total;
  const refreshList = async () => {
    const response = await apiClient.index
      .$get({
        query: { page: String(props.paging.page), per_page: String(CLIENTS_PER_PAGE), ...(props.search ? { search: props.search } : {}) },
      })
      .catch(() => null);
    // a list that cannot be read keeps what the page showed; closing the dialog reloads the page anyway
    if (!response?.ok) return;
    const body = await response.json();
    setListed({
      clients: body.clients.map((client) => ({ ...client, created: formatDate(client.createdAt, { locale: locale() }) })),
      total: body.pagination.total,
    });
  };

  // ── Deeds on an open client ───────────────────────────────────────────────────────────────────────────────────
  // A retry repeats what the person already agreed to; it does not ask again.
  const remove = async (client: ClientRow) => {
    const revoke = client.registrationKind === "dynamic";
    const action = revoke ? t().revokeAction : t().deleteAction;
    const agreed = await confirm({
      title: revoke ? t().revokeClient : t().deleteClient,
      description: t().confirmRemove({ action, name: client.name }),
      confirm: action,
    });
    if (agreed) await removeNow(client);
  };
  const removeNow = async (client: ClientRow) => {
    const response = await apiClient[":id"].$delete({ param: { id: client.id } }).catch(() => null);
    if (!response?.ok) {
      toast(client.registrationKind === "dynamic" ? t().notRevoked : t().notDeleted, {
        status: "bad",
        retry: () => void removeNow(client),
      });
      return;
    }
    location.assign(list());
  };
  const regenerate = async (client: ClientRow) => {
    const agreed = await confirm({ title: t().regenerateSecret, description: t().regenerateWarning, confirm: t().regenerate });
    if (agreed) await regenerateNow(client);
  };
  const regenerateNow = async (client: ClientRow) => {
    const response = await apiClient[":id"]["regenerate-secret"].$post({ param: { id: client.id } }).catch(() => null);
    const body = response?.ok ? await response.json() : null;
    if (!body || !("clientSecret" in body)) {
      toast(t().notRegenerated, { status: "bad", retry: () => void regenerateNow(client) });
      return;
    }
    setSecret({ title: t().secretRegenerated, clientId: null, value: body.clientSecret, reload: false });
  };
  const closeSecret = () => {
    const shown = secret();
    setSecret(null);
    if (shown?.reload) location.reload();
  };

  // ── Parts ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** The open client: who it is, what needs attention, three figures, its facts, where it sends people, who may use it. */
  const record = (client: ClientRow) => (
    <Pane
      detail
      label={client.name}
      back={{ label: t().backToClients, href: list() }}
      head={
        <Bar
          start={
            <Inline>
              <Mark {...markOf(client)} />
              <RecordHead name={client.name} kinds={badge(client) ? [badge(client)!] : undefined} />
            </Inline>
          }
          end={
            <>
              <Show when={client.registrationKind === "managed"}>
                <Menu
                  label={t().moreActions}
                  items={[
                    ...(client.isPublic ? [] : [{ label: t().regenerate, icon: "key", onClick: () => void regenerate(client) }]),
                    { label: t().deleteAction, icon: "trash", danger: true, onClick: () => void remove(client) },
                  ]}
                />
                <Button icon="pencil" keep onClick={() => start(client)}>
                  {t().edit}
                </Button>
              </Show>
              <Button variant="ghost" icon="x" label={t().close} href={list()} />
            </>
          }
        />
      }
    >
      {/* what needs attention stands first, with its one deed */}
      <Show when={client.registrationKind === "dynamic"}>
        <Notice
          tone="warn"
          title={t().unverifiedTitle}
          actions={[{ label: t().revokeAction, icon: "trash", onClick: () => void remove(client) }]}
        >
          {t().dynamicNote}
        </Notice>
      </Show>
      <Show when={client.registrationKind === "managed" && profileChoice(client.allowedProfiles) === "none"}>
        <Notice tone="warn" title={t().nobodyTitle} actions={[{ label: t().edit, icon: "pencil", onClick: () => start(client) }]}>
          {t().nobodyText}
        </Notice>
      </Show>
      {/* three key facts as a strip; the tinted object head of @k2b/ui takes them over in one step */}
      <Cells>
        <Cells.Cell
          icon="plug-connected"
          label={t().connected}
          value={client.serviceAccountId ? "–" : number(connectionsOf(client).active)}
          meta={client.serviceAccountId ? t().serviceAccountNoPeople : t().connectedPeople({ count: connectionsOf(client).peopleCount })}
        />
        <Cells.Cell
          icon="clock"
          label={t().lastUsed}
          value={lastUse(client)}
          meta={connectionsOf(client).people[0]?.name ?? t().neverUsed}
        />
        <Cells.Cell icon="calendar" label={t().created} value={client.created} meta={kindLine(client)} />
      </Cells>
      <Show when={!client.serviceAccountId}>
        <Section title={t().newPerDay} count={t().last30Days}>
          <Show when={connectionsOf(client).perDay.some((count) => count > 0)} fallback={<Text muted>{t().noConnectionsIn30Days}</Text>}>
            <Canvas label={t().newPerDay}>
              <DayBars
                values={connectionsOf(client).perDay}
                color={props.accent}
                axis={dayAxis(connectionsOf(client).perDay.length)}
                label={trendWords(client.name, connectionsOf(client).perDay)}
              />
            </Canvas>
          </Show>
        </Section>
      </Show>
      <Section title={t().access}>
        <Facts items={[{ label: t().whoMay, value: client.accessMode === "specific" ? t().chosenWords : profileLabel(client) }]} />
        <Show when={client.accessMode === "specific"}>
          <For each={client.accessUsers}>
            {(user) => (
              <Row
                avatar={{ name: user.displayName || user.uid }}
                lines={[user.displayName || user.uid]}
                meta={t().user}
                // a chosen person who uses the client now says so
                time={connected().has(user.id) ? t().connectedWord : undefined}
              />
            )}
          </For>
          <For each={client.accessGroups}>
            {(group) => <Row mark={GROUP_MARK} lines={[groupDisplayName(group.name, locale())]} meta={t().group} />}
          </For>
        </Show>
      </Section>
      <Show when={!client.serviceAccountId}>
        <Section title={t().connected} count={number(props.connectedPeople?.total ?? 0)}>
          <Show when={(props.connectedPeople?.people.length ?? 0) > 0} fallback={<Text muted>{t().nobodyConnectedYet}</Text>}>
            <For each={props.connectedPeople?.people ?? []}>
              {(person) => (
                <Row
                  avatar={{ name: person.name }}
                  lines={[person.name]}
                  meta={t().sinceDate({ date: shortDate(person.since) })}
                  time={person.lastUsedAt ? ago(person.lastUsedAt) : t().neverUsed}
                />
              )}
            </For>
            <Show when={(props.connectedPeople?.total ?? 0) > (props.connectedPeople?.people.length ?? 0)}>
              <Text type="meta" muted>
                {t().morePeople({ count: (props.connectedPeople?.total ?? 0) - (props.connectedPeople?.people.length ?? 0) })}
              </Text>
            </Show>
          </Show>
        </Section>
      </Show>
      <Section title={t().technique}>
        <Facts
          items={[
            {
              label: t().type,
              value:
                client.registrationKind === "first_party"
                  ? `${t().firstParty} · ${t().firstPartyNote}`
                  : client.registrationKind === "managed"
                    ? `${t().managed} · ${kindLine(client)}`
                    : `${t().dynamic} · ${client.isPublic ? t().public : t().confidential}`,
            },
            { label: t().clientId, value: client.clientId, mono: true, copy: client.clientId },
            // every address it sends people back to, each to copy; the label names the first
            ...(client.redirectUris.length === 0
              ? [{ label: t().redirectUri, value: t().noRedirect }]
              : client.redirectUris.map((uri, index) => ({
                  label: index === 0 ? t().redirectUri : "",
                  value: uri,
                  mono: true,
                  copy: uri,
                }))),
            ...(client.logoutUri ? [{ label: t().logoutUri, value: client.logoutUri, mono: true, copy: client.logoutUri }] : []),
            ...(client.isPublic ? [{ label: t().deviceGrant, value: client.allowDeviceGrant ? t().allowed : t().off }] : []),
            // k2b-ui gap: B shows each scope as a small mark; an Inline of chips in a fact cuts them instead of wrapping
            { label: t().scopes, value: client.scopes.join(" "), mono: true },
          ]}
        />
      </Section>
    </Pane>
  );

  /**
   * The one figure of the page with its real trend, and the exceptions as one line under it. A slot of its own, so the
   * hero band of @k2b/ui (figure type, chart) replaces it in one step.
   */
  const hero = () => {
    const a = props.activity;
    const newest = rows()
      .filter((client) => client.registrationKind === "dynamic")
      .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))[0];
    return (
      <>
        {/* the one figure with its real trend, in the colour of OAuth */}
        <Cells>
          <Cells.Cell
            icon="plug-connected"
            color={props.accent}
            label={t().activeConnectionsLabel}
            value={number(a.active)}
            meta={t().heroMeta({ people: number(a.people), fresh: number(a.newLast7) })}
            trend={{ values: a.perDay, label: trendWords(t().allClients, a.perDay), color: props.accent }}
          />
        </Cells>
        {/* the exceptions as one line: each its sign, its number, its word and quietly who */}
        <Show when={props.figures.dynamic > 0 || a.unused.count > 0 || props.search}>
          <Band>
            <Inline>
              <Show when={props.figures.dynamic > 0}>
                <Text>
                  <Icon name="world-plus" /> <Text weight="strong">{number(props.figures.dynamic)}</Text> {t().selfRegisteredWord}
                </Text>
                <Show when={newest}>
                  {(client) => (
                    <Text type="meta" muted>
                      {t().newestSince({ name: inLine(client().name), date: shortDate(client().createdAt) })}
                    </Text>
                  )}
                </Show>
              </Show>
              <Show when={a.unused.count > 0}>
                <Text>
                  <Text tone="warn">●</Text> <Text weight="strong">{number(a.unused.count)}</Text> {t().unusedWord}
                </Text>
                <Text type="meta" muted>
                  {a.unused.count > 1
                    ? t().nameAndMore({ name: inLine(a.unused.names[0] ?? ""), count: number(a.unused.count - 1) })
                    : inLine(a.unused.names[0] ?? "")}
                </Text>
              </Show>
              <Show when={props.search}>
                <Text type="meta" muted>
                  {t().searchResult({ query: props.search, count: total() })}
                </Text>
              </Show>
            </Inline>
          </Band>
        </Show>
      </>
    );
  };

  const clients = () => (
    <Pane label={t().clients} scrollKey="oauth-clients" width={props.open ? { min: 480, default: 640 } : undefined}>
      <Show when={!nothingYet()}>{hero()}</Show>
      {/* one line per client: its mark, name and badge; who is connected; its 30 days; when it was used last */}
      <Table
        label={t().clients}
        rows={rows()}
        rowKey={(client) => client.id}
        sticky
        current={props.open?.id}
        open={(client) => ({ href: href({ client: client.id }) })}
        empty={
          props.search
            ? {
                icon: "search-off",
                text: t().noMatch({ query: props.search }),
                action: { label: t().resetSearch, href: href({ search: "" }) },
              }
            : { icon: "key", text: t().noClients, action: { label: t().newClient, icon: "plus", onClick: () => start("new") } }
        }
        phone={(client) => ({
          lines: [client.name, secondLine(client)],
          // two lines, always, with the client's mark; a dot only for what needs a look
          mark: markOf(client),
          marks: unused(client) ? unusedMark(t().unusedShort) : undefined,
        })}
        columns={[
          // the name in its weight; a small neutral badge right after it only where the client is not the usual.
          // The name gives way first, so the badge always stands whole.
          {
            title: t().client,
            mark: (client) => markOf(client),
            // in the cell's own text flow, not an Inline: the cell cuts a long name with “…”, a flex row would clip it bare
            cell: (client) => (
              <>
                <Text weight="strong">{badge(client) && !props.open ? inLine(client.name) : client.name}</Text>
                {/* beside an open client the list is narrow; the open one says its kind in its head */}
                <Show when={!props.open && badge(client)}>
                  {(word) => (
                    <>
                      {" "}
                      <Chip>{word()}</Chip>
                    </>
                  )}
                </Show>
              </>
            ),
          },
          {
            title: t().connected,
            width: { fixed: 120 },
            cell: (client: ClientRow) => {
              const c = connectionsOf(client);
              if (client.serviceAccountId) return t().serviceAccount;
              if (nobodyMay(client)) return t().nobodyMay;
              if (c.active === 0) return t().nobodyConnected;
              const faces = c.people.slice(0, 2);
              return (
                <Inline>
                  <Avatar.Stack people={faces} max={2} label={t().connectedPeople({ count: c.peopleCount })} />
                  <Show when={c.active > faces.length}>
                    <Text type="meta" muted>{`+${number(c.active - faces.length)}`}</Text>
                  </Show>
                </Inline>
              );
            },
          },
          // the one column of data over time stays, also beside an open client
          {
            title: t().last30Days,
            width: { fixed: 110 },
            cell: (client: ClientRow) => {
              const c = connectionsOf(client);
              if (client.serviceAccountId) return "–";
              return c.perDay.some((count) => count > 0) ? (
                <Spark values={c.perDay} label={trendWords(client.name, c.perDay)} color={props.accent} />
              ) : (
                t().noUse
              );
            },
            drop: true,
          },
          {
            title: t().lastUsed,
            width: { fixed: 120 },
            cell: (client: ClientRow) =>
              unused(client) ? unusedMark(lastUse(client) === "–" ? t().neverUsed : lastUse(client)) : lastUse(client),
            drop: true,
          },
        ]}
      />
      <Show when={props.paging.pages > 1}>
        <Bar
          start={<Text type="meta">{`${number(props.paging.page)} / ${number(props.paging.pages)}`}</Text>}
          end={
            <>
              <Button
                icon="chevron-left"
                href={href({ page: props.paging.page - 1 })}
                disabled={props.paging.page <= 1}
                label={t().previous}
              />
              <Button
                icon="chevron-right"
                href={href({ page: props.paging.page + 1 })}
                disabled={props.paging.page >= props.paging.pages}
                label={t().next}
              />
            </>
          }
        />
      </Show>
    </Pane>
  );

  /** What an application needs to sign people in with this Cloud: its addresses, scopes and claims. */
  const endpoints = () => {
    const at = (path: string) => `${props.baseUrl}${path}`;
    const address = (label: string, path: string) => ({ label, value: at(path), mono: true, copy: at(path) });
    return (
      <Pane label={t().endpoints} scrollKey="oauth-endpoints">
        {/* one list of addresses and scopes, so they share one value column */}
        <Section icon="route" title={t().oauthEndpoints}>
          <Facts
            items={[
              address(t().openIdConfiguration, "/.well-known/openid-configuration"),
              address("JWKS", "/.well-known/jwks.json"),
              address(t().authorizationEndpoint, "/oauth/authorize"),
              address(t().tokenEndpoint, "/oauth/token"),
              address(t().dynamicRegistrationEndpoint, "/oauth/register"),
              address(t().userInfoEndpoint, "/oauth/userinfo"),
              address(t().logoutUrl, "/oauth/logout"),
              // each scope with the claims it returns: every claim is named once, in the same value column
              { label: t().scopeNamed({ scope: "openid" }), value: "sub, uid, id", mono: true, hint: t().openidClaims },
              { label: t().scopeNamed({ scope: "profile" }), value: "name, display_name, given_name, family_name", mono: true },
              { label: t().scopeNamed({ scope: "email" }), value: "email", mono: true },
              { label: t().scopeNamed({ scope: "groups" }), value: "groups", mono: true, hint: t().groupsClaims },
            ]}
          />
        </Section>
      </Pane>
    );
  };

  const opened = () => props.open;
  const _showsList = () => props.tab === "clients" && !props.open;
  /** No client yet and no search: the empty state is the one way to the first client, and there is nothing to search. */
  const nothingYet = () => props.figures.total === 0 && !props.search;

  return (
    <AdminWorkspace
      nav={props.nav}
      // the table takes the whole width until a client opens beside it
      detail={props.tab === "clients" && props.open ? 500 : undefined}
      // the main action on the list, floating at the bottom right on the phone (k2b-ui gap: Workspace keeps it over an open detail)
      primary={props.tab === "clients" && !nothingYet() ? { label: t().newClient, icon: "plus", onClick: () => start("new") } : undefined}
      head={
        <Bar
          start={
            <Tabs
              label="OAuth"
              items={[
                {
                  label: t().clients,
                  icon: "key",
                  href: href({ tab: "clients", client: null }),
                  count: total(),
                  current: props.tab === "clients",
                },
                { label: t().endpoints, icon: "route", href: href({ tab: "endpoints", client: null }), current: props.tab === "endpoints" },
              ]}
            />
          }
          end={
            <>
              <Show when={props.tab === "clients" && !nothingYet()}>
                <Input
                  type="search"
                  icon="search"
                  label={t().searchClientsLabel}
                  placeholder={t().searchClients}
                  value={props.search}
                  onKeyDown={(event) => {
                    if (event.isComposing) return;
                    const input = event.currentTarget as HTMLInputElement;
                    if (event.key === "Enter") location.assign(href({ search: input.value.trim(), client: null }));
                    if (event.key === "Escape" && input.value) location.assign(href({ search: "", client: null }));
                  }}
                />
              </Show>
              <Show when={props.tab === "clients" && !nothingYet()}>
                <Button variant="primary" icon="plus" onClick={() => start("new")}>
                  {t().newClient}
                </Button>
              </Show>
            </>
          }
        />
      }
    >
      <Show when={props.tab === "clients"} fallback={endpoints()}>
        <Pane.Split>
          {clients()}
          <Show when={opened()}>
            {(open) => (
              <Show
                when={open().found}
                fallback={
                  <Pane detail label={t().clients} back={{ label: t().backToClients, href: list() }}>
                    <Empty icon="file-off" text={t().notFound} action={{ label: t().backToClients, href: list() }} />
                  </Pane>
                }
              >
                {(client) => record(client())}
              </Show>
            )}
          </Show>
        </Pane.Split>
      </Show>

      <Dialog
        title={editingClient() ? t().editClient({ name: editingClient()!.name }) : t().newClient}
        open={editing() !== null}
        onOpenChange={(open) => !open && !busy() && setEditing(null)}
        dismissible={!busy()}
        foot={
          <>
            <Button onClick={() => setEditing(null)} disabled={busy()}>
              {t().cancel}
            </Button>
            <Button variant="primary" icon="check" busy={busy()} disabled={!canSave()} onClick={() => void save()}>
              {editing() === "new" ? t().create : t().save}
            </Button>
          </>
        }
      >
        <Show when={failure()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
        <Show
          when={editingClient()}
          fallback={
            <Field label={t().name} required>
              <Input value={draft().name} placeholder={t().namePlaceholder} onInput={(value) => change({ name: value })} />
            </Field>
          }
        >
          {(client) => <Facts items={[{ label: t().clientId, value: client().clientId, mono: true }]} />}
        </Show>
        <Field label={t().description}>
          <Input value={draft().description} placeholder={t().descriptionPlaceholder} onInput={(value) => change({ description: value })} />
        </Field>
        <Field label={t().redirectUri} hint={t().redirectUriDescription}>
          <Input
            multiline
            value={draft().redirectUris}
            placeholder="https://myapp.example.com/callback"
            spellcheck={false}
            autocapitalize="off"
            onInput={(value) => change({ redirectUris: value })}
          />
        </Field>
        <Field label={t().logoutUri} hint={t().logoutUriDescription}>
          <Input
            value={draft().logoutUri}
            placeholder="https://myapp.example.com/logout-callback"
            spellcheck={false}
            autocapitalize="off"
            onInput={(value) => change({ logoutUri: value })}
          />
        </Field>
        <Show when={editing() === "new"}>
          <Field label={t().clientKind}>
            <Choice
              name="kind"
              value={draft().isPublic ? "public" : "confidential"}
              onChange={(value) => change({ isPublic: value === "public" })}
              options={[
                { value: "confidential", label: t().confidentialChoice },
                { value: "public", label: t().publicChoice },
              ]}
            />
          </Field>
        </Show>
        <Show when={draft().isPublic}>
          <Field label={t().deviceGrant}>
            <Check
              label={t().deviceGrantChoice}
              checked={draft().allowDeviceGrant}
              onChange={(checked) => change({ allowDeviceGrant: checked })}
            />
          </Field>
        </Show>
        <Field label={t().whoCanUse} required>
          <Choice
            name="access"
            value={draft().specific ? "specific" : draft().profiles}
            onChange={(value) => {
              // chosen people keep the profiles already set, so a client that also lets guests in stays as it was
              if (value === "specific") change({ specific: true, profiles: draft().profiles === "none" ? "user" : draft().profiles });
              else if (value === "user" || value === "everybody" || value === "guest" || value === "none")
                change({ specific: false, profiles: value });
            }}
            options={[
              { value: "user", label: t().fullUsersOnly },
              { value: "everybody", label: t().everybody },
              { value: "guest", label: t().guestsOnly },
              { value: "specific", label: t().onlyChosen },
              { value: "none", label: t().noUserProfiles },
            ]}
          />
        </Field>
        <Show when={draft().specific}>
          <Field
            label={t().usersAndGroups}
            hint={t().nestedGroups}
            error={draft().principals.length === 0 ? t().selectPrincipal : undefined}
          >
            <Lookup
              label={t().usersAndGroups}
              value={draft().principals}
              onChange={(principals) => change({ principals })}
              load={loadPrincipals}
              known={knownPrincipals(editingClient())}
              minChars={1}
            />
          </Field>
        </Show>
        <Field label={t().scopes} hint={t().claimsClientCanRequest}>
          <For each={SCOPES}>
            {(scope) => (
              <Check
                label={scopeLabel(scope.id)}
                checked={draft().scopes.includes(scope.id)}
                onChange={(checked) =>
                  change({
                    scopes: checked
                      ? draft().scopes.includes(scope.id)
                        ? draft().scopes
                        : [...draft().scopes, scope.id]
                      : draft().scopes.filter((item) => item !== scope.id),
                  })
                }
              />
            )}
          </For>
        </Field>
      </Dialog>

      <Dialog
        title={secret()?.title ?? ""}
        open={secret() !== null}
        onOpenChange={(open) => !open && closeSecret()}
        dismissible={false}
        foot={<Button onClick={closeSecret}>{t().close}</Button>}
      >
        <Show when={secret()?.reload}>
          <Text>
            <Icon name="circle-check" tone="ok" label={t().clientCreated} /> {t().createdReady}
          </Text>
        </Show>
        <Show when={secret()?.value} fallback={<Text>{t().publicNoSecret}</Text>}>
          <Text>
            <Icon name="alert-triangle" tone="warn" /> {t().saveSecretNow}
          </Text>
        </Show>
        <Facts
          items={[
            ...(secret()?.clientId ? [{ label: t().clientId, value: secret()!.clientId!, mono: true, copy: secret()!.clientId! }] : []),
            ...(secret()?.value ? [{ label: t().clientSecret, value: secret()!.value!, mono: true, copy: secret()!.value! }] : []),
          ]}
        />
      </Dialog>
    </AdminWorkspace>
  );
}
