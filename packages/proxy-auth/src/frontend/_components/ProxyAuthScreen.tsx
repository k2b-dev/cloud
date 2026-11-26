import { groupDisplayName } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Cells,
  Chip,
  confirm,
  Dialog,
  Empty,
  Facts,
  Field,
  Inline,
  Input,
  Lookup,
  Menu,
  type NavProps,
  Notice,
  Pane,
  Prose,
  Row,
  Section,
  Steps,
  Table,
  Tabs,
  Text,
  useToast,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal, For, Show } from "solid-js";
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
  /** The colour of Proxy Auth itself: its figures carry it inside the Administration shell. */
  accent: string;
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
  const verifyUrl = (clientId: string) => `${props.baseUrl}/proxy-auth/verify/${clientId}`;
  const opened = () => props.clients.find((client) => client.id === props.open) ?? null;
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
  const rows = () =>
    [...props.clients, ...added()].sort(
      (a, b) => Number(a.groups.length > 0) - Number(b.groups.length > 0) || a.name.localeCompare(b.name, locale()),
    );
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

  /** A client without groups lets nobody through until it has one: the state as dot and word, no pill. */
  const blocked = () => <Text tone="bad">{`● ${t().blockedState}`}</Text>;
  /** The groups that get through, as words; a client without one says so quietly (its state says the rest). */
  const groupLine = (client: ClientRow) =>
    client.groups.length === 0 ? t().noGroups : client.groups.map((group) => group.label).join(", ");
  /** A name cut by grapheme to the room it has; the open client says it whole. */
  const clip = (text: string, room: number) => {
    const graphemes = [...new Intl.Segmenter(locale(), { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
    return graphemes.length > room
      ? `${graphemes
          .slice(0, room - 1)
          .join("")
          .trimEnd()}…`
      : text;
  };
  /** The room of a key figure's quiet line, which does not cut itself (k2b-ui gap). */
  const STRIP_LINE = 24;
  /** The groups in one short line: the first, then how many more; the open client lists them all. */
  const groupShort = (client: ClientRow, room = 40) =>
    client.groups.length === 0
      ? groupLine(client)
      : client.groups.length === 1
        ? clip(client.groups[0]!.label, room)
        : t().groupAndMore({ name: clip(client.groups[0]!.label, room), count: number(client.groups.length - 1) });

  /** A figure in the person's number format. */
  const number = (value: number) => value.toLocaleString(locale());
  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value);
    toast(t().copied, { status: "ok" });
  };

  /**
   * The open client: a band when nobody gets through, the address Traefik asks (the hero of a proxy client), the
   * groups that get through, then its facts.
   */
  const record = (client: ClientRow) => (
    <Pane
      detail
      label={client.name}
      back={{ label: t().backToClients, href: listHref() }}
      head={
        <Bar
          start={<Text type="lead">{client.name}</Text>}
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
      {/* the one problem a proxy client can have, right under its name, with its cause and the way out */}
      <Show when={client.groups.length === 0}>
        <Notice tone="bad" title={t().nobodyThroughTitle} actions={[{ label: t().chooseGroupsAction, onClick: () => start(client) }]}>
          {t().nobodyThroughCause}
        </Notice>
      </Show>
      {/* what it is for, quietly under its name; the tinted object head of @k2b/ui takes it over in one step */}
      <Show when={client.description}>
        {(text) => (
          <Band>
            <Text muted>{text()}</Text>
          </Band>
        )}
      </Show>
      {/* two key facts as a strip: each fact is said once */}
      <Cells>
        <Cells.Cell
          icon="users-group"
          label={t().allowedGroups}
          value={number(client.groups.length)}
          meta={client.groups.length === 0 ? t().chooseGroups : groupShort(client, STRIP_LINE)}
        />
        <Cells.Cell icon="calendar" label={t().created} value={client.created} />
      </Cells>
      <Section title={t().verifyUrl} summary={t().verifySummary}>
        <Facts items={[{ label: t().address, value: verifyUrl(client.clientId), mono: true, copy: verifyUrl(client.clientId) }]} />
      </Section>
      <Section title={t().allowedGroups} count={client.groups.length}>
        <Show when={client.groups.length > 0} fallback={<Text muted>{t().noGroups}</Text>}>
          <For each={client.groups}>{(group) => <Row icon="users-group" lines={[group.label]} />}</For>
        </Show>
      </Section>
      {/* what an administrator needs to copy; the description stands under the name, created in the strip */}
      <Section title={t().technique}>
        <Facts items={[{ label: t().clientId, value: client.clientId, mono: true, copy: client.clientId }]} />
      </Section>
    </Pane>
  );

  /**
   * The one statement of the page with its figure: how many clients let nobody through, else how many there are. A slot
   * of its own, so the hero band of @k2b/ui (figure type) replaces it in one step. Proxy Auth keeps no use of its clients,
   * so the hero has no trend.
   */
  const hero = () => {
    const blockedCount = props.figures.withoutGroups;
    const names = rows()
      .filter((client) => client.groups.length === 0)
      .map((client) => client.name);
    return (
      <Cells>
        <Cells.Cell
          icon={blockedCount > 0 ? "lock" : "shield-check"}
          color={props.accent}
          label={blockedCount > 0 ? t().blockedLabel : t().gatedLabel}
          value={number(blockedCount > 0 ? blockedCount : props.figures.total)}
          meta={
            props.search
              ? t().shownOf({ shown: rows().length, total: props.figures.total })
              : blockedCount > 0
                ? t().blockedWho({ names: clip(names[0] ?? "", NAME_IN_LINE), more: Math.max(0, names.length - 1) })
                : t().groupsInUse({ count: groupsInUse() })
          }
        />
      </Cells>
    );
  };

  /** The groups that get through any client, counted once. */
  const groupsInUse = () => new Set(rows().flatMap((client) => client.groups.map((group) => group.id))).size;
  /** The room of a name in a quiet line beside other words. */
  const NAME_IN_LINE = 32;

  /** The clients with their figures, one open beside them. */
  const list = () => (
    <Pane.Split>
      <Pane label={t().appName} scrollKey="proxy-auth-clients">
        <Show when={!nothingYet()}>{hero()}</Show>
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
          // two lines on the phone: the name, then its groups and since when
          phone={(client) => ({
            lines: [client.name, `${groupShort(client)} · ${client.created}`],
            marks: client.groups.length === 0 ? blocked() : undefined,
          })}
          // one line per client; colour only for the state that needs a look
          columns={[
            {
              title: t().client,
              width: { min: 180, default: 240 },
              cell: (client) => (
                <Inline>
                  <Text weight="strong">{client.groups.length === 0 ? clip(client.name, NAME_IN_LINE) : client.name}</Text>
                  <Show when={client.groups.length === 0}>{blocked()}</Show>
                </Inline>
              ),
            },
            { title: t().allowedGroups, width: { min: 140, default: 180 }, cell: (client) => groupLine(client), drop: true },
            ...(props.open
              ? []
              : [{ title: t().created, width: { min: 110, default: 120 }, cell: (client: ClientRow) => client.created, drop: true }]),
          ]}
        />
        <Show when={nothingYet()}>
          <Section title={t().howItWorks}>
            {/* k2b-ui gap: a code block of its own; Prose code has no ground and runs out of a narrow place, so the
                piece of configuration stays in the setup tab */}
            <Steps label={t().howItWorks} items={firstSteps("next")} />
          </Section>
        </Show>
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

  /** The piece of Traefik configuration for a client, as a code block. */
  const traefikExample = () =>
    [
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
    ].join("\n");
  /** The way to a protected app in three steps; `first` is the state of the first one. */
  const firstSteps = (first: "done" | "next") => [
    { label: t().stepCreate, state: first },
    { label: t().stepTraefik, state: first === "done" ? ("now" as const) : ("next" as const) },
    { label: t().stepTry, state: "next" as const },
  ];

  /** The Traefik setup: the verify address of a client, an example and the headers the app receives. */
  const setup = () => (
    <Pane label={t().setupTitle} scrollKey="proxy-auth-setup">
      <Section title={t().verifyUrl} summary={t().setupDescription}>
        <Facts items={[{ label: t().pattern, value: `${props.baseUrl}/proxy-auth/verify/<client-id>`, mono: true }]} />
      </Section>
      <Section title={t().exampleConfiguration}>
        <Prose markdown={traefikExample()} />
      </Section>
      <Section title={t().responseHeaders}>
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
                { label: t().clients, icon: "shield-half", href: LIST, count: props.figures.total, current: props.tab === "clients" },
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
        <Steps label={t().howItWorks} items={firstSteps("done")} />
        <Text>{t().nextStep}</Text>
        <Facts items={[{ label: t().verifyUrl, value: verifyUrl(created() ?? ""), mono: true, copy: verifyUrl(created() ?? "") }]} />
      </Dialog>
    </AdminWorkspace>
  );
}
