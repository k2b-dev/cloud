import { groupDisplayName } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  confirm,
  Dialog,
  Empty,
  Facts,
  Field,
  Icon,
  Input,
  Lookup,
  Menu,
  type NavProps,
  Notice,
  Pane,
  Prose,
  Section,
  StatusRow,
  Table,
  Tabs,
  Text,
  useToast,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { clientRow } from "../client-row";
import { proxyAuthMessages } from "../messages";

/** One client in the list, worded by the server. */
export type ClientRow = {
  id: string;
  clientId: string;
  name: string;
  description: string | null;
  groups: { id: string; label: string }[];
  created: string;
};

export type ProxyAuthScreenProps = {
  nav: NavProps;
  /** The public address of this Cloud, for the verify address and the example. */
  baseUrl: string;
  clients: ClientRow[];
  /** The clients, or the Traefik setup (`tab=setup`). */
  tab: "clients" | "setup";
  /** The client open beside the list (`client=<id>`); null when none is, or it is gone. */
  open: string | null;
  figures: { withoutGroups: number; total: number };
  /** The search of the list (`search=`), matched on the server; empty for none. */
  search: string;
};

type Draft = { name: string; description: string; groups: string[] };

const LIST = "/admin/proxy-auth";

/**
 * Proxy Auth on v2: the clients Traefik's ForwardAuth asks before it lets a request through to an external app, each
 * gated by groups. A client opens beside the list with its verify address and its deeds; the setup stays below.
 */
export default function ProxyAuthScreen(props: ProxyAuthScreenProps) {
  const locale = useLocale();
  const t = () => proxyAuthMessages.resolve([locale()]).t;
  const toast = useToast();
  const number = (value: number) => value.toLocaleString(locale());
  const verifyUrl = (clientId: string) => `${props.baseUrl}/proxy-auth/verify/${clientId}`;
  const opened = () => props.clients.find((client) => client.id === props.open) ?? null;
  /** A client's sign in the colour of its state: it lets its groups through, or nobody until it has one. */
  const ClientName = (mark: { client: ClientRow }) => (
    <>
      <Icon name={mark.client.groups.length === 0 ? "lock" : "shield-check"} tone={mark.client.groups.length === 0 ? "warn" : "ok"} />{" "}
      {mark.client.name}
    </>
  );
  const known = (): LookupItem[] =>
    props.clients.flatMap((client) => client.groups).map((group) => ({ value: group.id, label: group.label }));

  // groups come from the directory, as the access editors search them
  const loadGroups = async (text: string, context: { signal: AbortSignal; limit: number }) => {
    const url = new URL("/api/accounts/entities", location.origin);
    url.searchParams.set("search", text);
    url.searchParams.set("kinds", "group");
    url.searchParams.set("per_page", String(context.limit));
    const response = await fetch(url, { credentials: "same-origin", signal: context.signal });
    if (!response.ok) throw new Error(response.statusText);
    const data: { items?: { kind: string; group?: { id: string; name: string } }[] } = await response.json();
    const items = (data.items ?? []).flatMap((item) =>
      item.kind === "group" && item.group ? [{ value: item.group.id, label: groupDisplayName(item.group.name, locale()) }] : [],
    );
    return { items };
  };

  // ── Create and edit: one dialog ───────────────────────────────────────────────────────────────────────────────
  const [editing, setEditing] = createSignal<ClientRow | "new" | null>(null);
  const [draft, setDraft] = createSignal<Draft>({ name: "", description: "", groups: [] });
  const [failure, setFailure] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [created, setCreated] = createSignal<string | null>(null);
  // a client just created stands in the list behind its dialog; the next page load brings it from the server
  const [added, setAdded] = createSignal<ClientRow[]>([]);
  const rows = () => [...props.clients, ...added()].sort((a, b) => a.name.localeCompare(b.name, locale()));
  /** No client yet and no search: the empty state is the one way to the first client, and there is nothing to search. */
  const nothingYet = () => props.figures.total === 0 && added().length === 0 && !props.search;
  const clientsHref = (client: ClientRow) =>
    `${LIST}?${new URLSearchParams({ ...(props.search ? { search: props.search } : {}), client: client.id })}`;
  const listHref = () => (props.search ? `${LIST}?${new URLSearchParams({ search: props.search })}` : LIST);
  const start = (client: ClientRow | "new") => {
    setDraft(
      client === "new"
        ? { name: "", description: "", groups: [] }
        : { name: client.name, description: client.description ?? "", groups: client.groups.map((group) => group.id) },
    );
    setFailure(null);
    setEditing(client);
  };
  const save = async () => {
    const target = editing();
    if (!target) return;
    const values = draft();
    if (target === "new" && !values.name.trim()) return setFailure(t().nameRequired);
    if (values.groups.length === 0) return setFailure(t().groupRequired);
    setBusy(true);
    // a store that refuses names it; a lost connection is "not saved", never a browser's own error text
    const response = await (target === "new"
      ? apiClient.index.$post({
          json: { name: values.name.trim(), description: values.description.trim() || undefined, allowedGroupIds: values.groups },
        })
      : apiClient[":id"].$put({
          param: { id: target.id },
          json: { description: values.description.trim() || null, allowedGroupIds: values.groups },
        })
    ).catch(() => null);
    setBusy(false);
    if (!response) return setFailure(t().notSaved);
    if (!response.ok) return setFailure(target === "new" ? t().failedCreate : t().failedUpdate);
    setEditing(null);
    if (target === "new") {
      // the service's answer is the whole client: its row is built as the page builds its rows
      const body = await response.json();
      if ("clientId" in body) {
        setAdded((rows) => [...rows, clientRow(body, locale())]);
        setCreated(body.clientId);
      }
    } else {
      // the next picture shows the change; a toast before the page is replaced would never be seen
      location.reload();
    }
  };
  const remove = async (client: ClientRow) => {
    const agreed = await confirm({ title: t().deleteClient, description: t().deleteConfirm({ name: client.name }), confirm: t().delete });
    if (!agreed) return;
    const response = await apiClient[":id"].$delete({ param: { id: client.id } }).catch(() => null);
    if (!response?.ok) {
      toast(t().notDeleted, { status: "bad", retry: () => void remove(client) });
      return;
    }
    location.assign(LIST);
  };

  /** A client without groups lets nobody through until it has one: state in colour, symbol and word. */
  const blocked = () => (
    <Chip status="warn" icon="lock">
      {t().noGroups}
    </Chip>
  );

  /** The groups as words; without one, the fact that nobody gets through, with its sign. */
  const groupWords = (client: ClientRow) =>
    client.groups.length === 0 ? (
      <>
        <Icon name="lock" tone="warn" /> {t().blockedFact}
      </>
    ) : (
      client.groups.map((group) => group.label).join(", ")
    );

  const record = (client: ClientRow) => (
    <Pane
      detail
      label={client.name}
      back={{ label: t().backToClients, href: listHref() }}
      head={
        <Bar
          start={<Text weight="strong">{client.name}</Text>}
          end={
            <>
              <Menu
                label={t().moreActions}
                items={[{ label: t().delete, icon: "trash", danger: true, onClick: () => void remove(client) }]}
              />
              <Button icon="pencil" keep onClick={() => start(client)}>
                {t().edit}
              </Button>
              <Button variant="ghost" icon="x" label={t().close} href={listHref()} />
            </>
          }
        />
      }
    >
      {/* k2b-ui gap: Facts mono breaks an ID or hash at any sign; IDs need one line with an ellipsis and copy (DP). */}
      <Facts
        items={[
          // who gets through comes first: the groups, or the fact that nobody does yet
          { label: t().allowedGroups, value: <>{groupWords(client)}</> },
          { label: t().verifyUrl, value: verifyUrl(client.clientId), mono: true, copy: verifyUrl(client.clientId) },
          { label: t().clientId, value: client.clientId, mono: true, copy: client.clientId },
          ...(client.description ? [{ label: t().description, value: client.description }] : []),
          { label: t().created, value: client.created },
        ]}
      />
    </Pane>
  );

  /** The clients with their figures, one open beside them. */
  const list = () => (
    <Pane.Split>
      <Pane
        label={t().appName}
        scrollKey="proxy-auth-clients"
        // the first row says what matters with its number; the list's count and the search are quiet facts
        status={
          <StatusRow
            lead={
              rows().length === 0 && !props.search
                ? t().emptyLead
                : props.figures.withoutGroups > 0
                  ? t().blockedLead({ count: props.figures.withoutGroups })
                  : t().allGatedLead({ count: props.figures.total })
            }
            // quiet meta: the number of clients, or how many of them a search shows (the query stands in the field)
            facts={
              props.search
                ? [{ before: t().shownOf({ shown: rows().length, total: props.figures.total }) }]
                : rows().length > 0
                  ? [{ before: t().clientCount({ count: rows().length }) }]
                  : []
            }
          />
        }
      >
        <Table
          label={t().clients}
          rows={rows()}
          rowKey={(client) => client.id}
          sticky
          current={props.open ?? undefined}
          open={(client) => ({ href: clientsHref(client) })}
          // the empty state holds its way on; a search that finds nothing says so and how to see all again
          empty={
            props.search
              ? { icon: "search-off", text: t().noMatch({ query: props.search }), action: { label: t().resetSearch, href: LIST } }
              : // the one way to the first client: the head and the phone's button hold none while the list is empty
                { icon: "shield-half", text: t().empty, action: { label: t().newClient, icon: "plus", onClick: () => start("new") } }
          }
          phone={(client) => ({
            lines: [<ClientName client={client} />, client.description || client.clientId],
            time: client.created,
            marks: client.groups.length === 0 ? blocked() : undefined,
          })}
          columns={[
            {
              title: t().client,
              width: { min: 200, default: 320 },
              cell: (client) =>
                client.description ? { lines: [<ClientName client={client} />, client.description] } : <ClientName client={client} />,
            },
            {
              title: t().allowedGroups,
              width: { min: 160, default: 280 },
              // the groups as words; only a client without one carries a chip, the exception
              cell: (client) => (client.groups.length === 0 ? blocked() : client.groups.map((group) => group.label).join(", ")),
              drop: true,
            },
            { title: t().created, width: { min: 110, default: 140 }, cell: (client) => client.created, drop: true },
          ]}
        />
      </Pane>
      <Show when={props.tab === "clients" && props.open}>
        <Show
          when={opened()}
          fallback={
            <Pane detail label={t().clients} back={{ label: t().backToClients, href: listHref() }}>
              <Empty icon="file-off" text={t().notFound} action={{ label: t().backToClients, href: listHref() }} />
            </Pane>
          }
        >
          {(client) => record(client())}
        </Show>
      </Show>
    </Pane.Split>
  );

  /** The Traefik setup: the verify address of a client, an example and the headers the app receives. */
  const setup = () => (
    <Pane label={t().setupTitle} scrollKey="proxy-auth-setup">
      <Section icon="link" title={t().verifyUrl} summary={t().setupDescription}>
        <Facts items={[{ label: t().pattern, value: `${props.baseUrl}/proxy-auth/verify/<client-id>`, mono: true }]} />
      </Section>
      <Section icon="file-code" title={t().exampleConfiguration}>
        <Prose
          markdown={[
            "```yaml",
            "http:",
            "  middlewares:",
            "    my-proxy-auth:",
            "      forwardAuth:",
            `        address: "${props.baseUrl}/proxy-auth/verify/<client-id>"`,
            "        authResponseHeaders:",
            '          - "X-Forwarded-User"',
            '          - "X-Forwarded-Email"',
            '          - "X-Forwarded-Groups"',
            "        trustForwardHeader: true",
            "```",
          ].join("\n")}
        />
      </Section>
      <Section icon="list-details" title={t().responseHeaders}>
        <Facts
          items={[
            { label: "X-Forwarded-User", value: t().username },
            { label: "X-Forwarded-Email", value: t().emailAddress },
            { label: "X-Forwarded-Groups", value: t().groupList },
          ]}
        />
      </Section>
    </Pane>
  );

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.tab === "clients" && props.open ? 440 : undefined}
      // the main action on the list, floating at the bottom right on the phone; never over an open client or the setup
      primary={props.tab === "clients" && !nothingYet() ? { label: t().newClient, icon: "plus", onClick: () => start("new") } : undefined}
      head={
        <Bar
          start={
            <Tabs
              label={t().appName}
              items={[
                { label: t().clients, icon: "shield-half", href: LIST, current: props.tab === "clients" },
                { label: t().setupTitle, icon: "route", href: `${LIST}?tab=setup`, current: props.tab === "setup" },
              ]}
            />
          }
          end={
            <Show when={props.tab === "clients" && !nothingYet()}>
              <Input
                type="search"
                icon="search"
                label={t().searchLabel}
                placeholder={t().searchPlaceholder}
                value={props.search}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  const text = input.value.trim();
                  if (event.key === "Enter") location.assign(text ? `${LIST}?${new URLSearchParams({ search: text })}` : LIST);
                  if (event.key === "Escape" && input.value) location.assign(LIST);
                }}
              />
              <Button variant="primary" icon="plus" onClick={() => start("new")}>
                {t().newClient}
              </Button>
            </Show>
          }
        />
      }
    >
      {props.tab === "setup" ? setup() : list()}
      <Dialog
        title={(() => {
          const target = editing();
          return target === "new" || !target ? t().newProxyClient : t().editClient({ name: target.name });
        })()}
        open={editing() !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        foot={
          <>
            <Button onClick={() => setEditing(null)}>{t().cancel}</Button>
            <Button variant="primary" icon="check" busy={busy()} onClick={() => void save()}>
              {editing() === "new" ? t().create : t().save}
            </Button>
          </>
        }
      >
        <Show when={failure()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
        <Show when={editing() === "new"}>
          <Field label={t().clientName}>
            <Input value={draft().name} onInput={(value) => setDraft({ ...draft(), name: value })} />
          </Field>
        </Show>
        <Field label={t().description}>
          <Input
            value={draft().description}
            placeholder={t().optionalDescription}
            onInput={(value) => setDraft({ ...draft(), description: value })}
          />
        </Field>
        <Field label={t().allowedGroups}>
          <Lookup
            label={t().allowedGroups}
            value={draft().groups}
            onChange={(groups) => setDraft({ ...draft(), groups })}
            load={loadGroups}
            known={known()}
            minChars={0}
          />
        </Field>
      </Dialog>
      <Dialog
        title={t().clientCreated}
        open={created() !== null}
        onOpenChange={(open) => {
          if (!open) location.reload();
        }}
        dismissible={false}
        foot={
          <>
            <Button onClick={() => location.reload()}>{t().close}</Button>
            <Button variant="primary" icon="route" href={`${LIST}?tab=setup`}>
              {t().toSetup}
            </Button>
          </>
        }
      >
        <Text>
          <Icon name="circle-check" tone="ok" label={t().clientCreated} /> {t().nextStep}
        </Text>
        <Facts items={[{ label: t().verifyUrl, value: verifyUrl(created() ?? ""), mono: true, copy: verifyUrl(created() ?? "") }]} />
      </Dialog>
    </AdminWorkspace>
  );
}
