import { formatDate, groupDisplayName } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
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
  Row,
  Section,
  StatusRow,
  Table,
  Tabs,
  Text,
  useToast,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { OAuthClient, OAuthScope } from "@/contracts";
import { CLIENTS_PER_PAGE } from "../clients-page";
import { oauthMessages } from "../messages";
import { GROUP_MARK, KIND_MARKS } from "./kind-marks";
import { clientEditorUpdate, clientEditorValues, type ProfileChoice, profileChoice, profilesForChoice } from "./client-editor";

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

  // ── Words for a client ────────────────────────────────────────────────────────────────────────────────────────
  const kind = (client: OAuthClient) =>
    client.registrationKind === "first_party" ? t().firstParty : client.registrationKind === "dynamic" ? t().dynamic : t().managed;
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
  const markOf = (client: OAuthClient) => KIND_MARKS[client.registrationKind];
  /** The host a client sends people back to, for a second line that says where it lives. */
  const redirectHost = (client: OAuthClient) => {
    const first = client.redirectUris[0];
    if (!first) return "";
    try {
      return new URL(first).host;
    } catch {
      return first;
    }
  };
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
    [kindLine(client), client.description || redirectHost(client) || t().withoutRedirect].join(" · ");
  /** The people and groups a client is limited to, as faces. */
  const accessPeople = (client: OAuthClient) => [
    ...client.accessUsers.map((user) => ({ name: user.displayName || user.uid })),
    ...client.accessGroups.map((group) => ({ name: groupDisplayName(group.name, locale()) })),
  ];
  /** A state that needs a look, as dot and word: a client nobody checked, or one nobody may use. */
  const stateChip = (client: OAuthClient) =>
    client.registrationKind === "dynamic" ? (
      <Chip status="warn">{t().unverified}</Chip>
    ) : profileChoice(client.allowedProfiles) === "none" ? (
      <Chip status="bad">{t().profileNobody}</Chip>
    ) : undefined;
  /** Who may sign in, in a table cell: the profile as a word, or the faces of the chosen people and groups. */
  const accessCell = (client: OAuthClient) =>
    client.accessMode === "specific" ? (
      <Avatar.Stack people={accessPeople(client)} max={3} label={t().selected({ count: accessPeople(client).length })} />
    ) : profileChoice(client.allowedProfiles) === "none" ? (
      "–"
    ) : (
      ({ user: t().profileUsers, everybody: t().profileEverybody, guest: t().profileGuests, none: t().profileNobody } as const)[
        profileChoice(client.allowedProfiles)
      ]
    );
  /** Who may sign in, as words: the profile, or the chosen people and groups. */
  const accessValue = (client: OAuthClient) =>
    client.accessMode === "specific"
      ? number(accessPeople(client).length)
      : ({ user: t().profileUsers, everybody: t().profileEverybody, guest: t().profileGuests, none: t().profileNobody } as const)[
          profileChoice(client.allowedProfiles)
        ];
  /** A long ID shortened in the middle, whole when copied. */
  const shortId = (id: string) => (id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    toast(t().copied, { status: "ok" });
  };

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
              <Text type="lead">{client.name}</Text>
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
        <Notice tone="warn" title={t().unverifiedTitle} actions={[{ label: t().revokeAction, icon: "trash", onClick: () => void remove(client) }]}>
          {t().dynamicNote}
        </Notice>
      </Show>
      <Show when={client.registrationKind === "managed" && profileChoice(client.allowedProfiles) === "none"}>
        <Notice tone="warn" title={t().nobodyTitle} actions={[{ label: t().edit, icon: "pencil", onClick: () => start(client) }]}>
          {t().nobodyText}
        </Notice>
      </Show>
      <Cells>
        <Cells.Cell
          icon="users"
          label={t().access}
          value={accessValue(client)}
          meta={client.accessMode === "specific" ? t().chosenMeta : t().everyoneOfProfile}
        />
        <Cells.Cell
          icon="arrow-back-up"
          label={t().redirects}
          value={number(client.redirectUris.length)}
          meta={redirectHost(client) || t().noRedirect}
        />
        <Cells.Cell icon="key" label={t().scopes} value={number(client.scopes.length)} meta={client.scopes.join(", ")} />
      </Cells>
      <Section icon="settings" title={t().details}>
        <Facts
          items={[
            { label: t().clientId, value: shortId(client.clientId), mono: true, copy: client.clientId },
            {
              label: t().type,
              value:
                client.registrationKind === "first_party"
                  ? `${t().firstParty} · ${t().firstPartyNote}`
                  : client.registrationKind === "managed"
                    ? `${t().managed} · ${kindLine(client)}`
                    : `${t().dynamic} · ${client.isPublic ? t().public : t().confidential}`,
            },
            ...(client.isPublic ? [{ label: t().deviceGrant, value: client.allowDeviceGrant ? t().allowed : t().off }] : []),
            ...(client.logoutUri ? [{ label: t().logoutUri, value: client.logoutUri, mono: true, copy: client.logoutUri }] : []),
            { label: t().created, value: client.created },
          ]}
        />
      </Section>
      <Section icon="arrow-back-up" title={t().redirectUri} count={number(client.redirectUris.length)}>
        <Show when={client.redirectUris.length > 0} fallback={<Text muted>{t().noRedirectText}</Text>}>
          <For each={client.redirectUris}>
            {(uri) => (
              <Row
                icon="link"
                lines={[uri]}
                end={<Button variant="ghost" icon="copy" label={t().copyUri} onClick={() => copy(uri)} />}
              />
            )}
          </For>
        </Show>
      </Section>
      <Section icon="users" title={t().access} count={client.accessMode === "specific" ? number(accessPeople(client).length) : undefined}>
        <Show
          when={client.accessMode === "specific"}
          fallback={<Row icon="users" lines={[profileLabel(client), t().everyoneOfProfile]} />}
        >
          <For each={client.accessUsers}>
            {(user) => <Row avatar={{ name: user.displayName || user.uid }} lines={[user.displayName || user.uid, t().user]} />}
          </For>
          <For each={client.accessGroups}>
            {(group) => <Row mark={GROUP_MARK} lines={[groupDisplayName(group.name, locale()), t().group]} />}
          </For>
        </Show>
      </Section>
    </Pane>
  );

  const clients = () => (
    <Pane
      label={t().clients}
      scrollKey="oauth-clients"
      // the first row says what matters with its number; the list's count and the search are quiet facts
      status={
        <StatusRow
          lead={
            total() === 0 && !props.search
              ? t().emptyLead
              : props.figures.dynamic > 0
                ? t().dynamicLead({ count: props.figures.dynamic })
                : t().managedLead
          }
          facts={props.search ? [{ before: t().searchFact, after: props.search }] : []}
          // the count stands at the end of the row, as in a console's toolbar
          filters={
            total() > 0 ? (
              <Text type="meta" muted>
                {t().clientCount({ count: total() })}
              </Text>
            ) : undefined
          }
        />
      }
    >
      {/* a dense table: one line per client, a neutral badge for its kind, colour only for a state that needs a look */}
      <Table
        label={t().clients}
        rows={rows()}
        rowKey={(client) => client.id}
        sticky
        current={props.open?.id}
        open={(client) => ({ href: href({ client: client.id }) })}
        empty={
          props.search
            ? { icon: "search-off", text: t().noMatch({ query: props.search }), action: { label: t().resetSearch, href: href({ search: "" }) } }
            : { icon: "key", text: t().noClients, action: { label: t().newClient, icon: "plus", onClick: () => start("new") } }
        }
        phone={(client) => ({ lines: [client.name, secondLine(client)], time: client.created, marks: stateChip(client) })}
        columns={[
          {
            title: t().client,
            width: { min: 160, default: 200 },
            // the kind stands in its own column; the name alone here
            cell: (client) => client.name,
          },
          // a state that needs a look has its own column, so a long name never cuts it
          { title: t().state, width: { min: 130, default: 130 }, cell: (client: ClientRow) => stateChip(client) ?? "" },
          // kind and date are secondary: the open client and the phone's second line hold them, so no column is cut at 1024
          ...(props.open
            ? []
            : [
                {
                  title: t().redirectTarget,
                  width: { min: 150, default: 180 },
                  cell: (client: ClientRow) => redirectHost(client) || t().withoutRedirect,
                  drop: true,
                },
              ]),
          { title: t().access, width: { min: 110, default: 120 }, cell: (client) => accessCell(client), drop: true },
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
      detail={props.tab === "clients" && props.open ? 460 : undefined}
      // the main action on the list, floating at the bottom right on the phone; never over an open client
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
