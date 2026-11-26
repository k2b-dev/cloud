import { groupDisplayName } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Cells,
  Chip,
  confirm,
  Dialog,
  Empty,
  Facts,
  Field,
  Input,
  Lookup,
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
import { createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
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
  figures: { groups: number; withoutGroups: number };
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
    return {
      items: (data.items ?? []).flatMap((item) =>
        item.kind === "group" && item.group ? [{ value: item.group.id, label: groupDisplayName(item.group.name, locale()) }] : [],
      ),
    };
  };

  // ── Create and edit: one dialog ───────────────────────────────────────────────────────────────────────────────
  const [editing, setEditing] = createSignal<ClientRow | "new" | null>(null);
  const [draft, setDraft] = createSignal<Draft>({ name: "", description: "", groups: [] });
  const [failure, setFailure] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [created, setCreated] = createSignal<string | null>(null);
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
      const body = await response.json();
      if ("clientId" in body) setCreated(body.clientId);
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

  /**
   * The groups as chips; in a row only as many as its column holds whole (two short ones, else one) and "+n" for the
   * rest, which the open client lists.
   */
  const groupChips = (client: ClientRow, row = false) => {
    if (client.groups.length === 0) return blocked();
    const fit = row ? (client.groups.slice(0, 2).reduce((sum, group) => sum + group.label.length, 0) <= 24 ? 2 : 1) : client.groups.length;
    const shown = client.groups.slice(0, fit);
    return (
      <>
        <For each={shown}>{(group) => <Chip icon="users-group">{group.label}</Chip>}</For>
        <Show when={client.groups.length > shown.length}>
          <Chip>{`+${number(client.groups.length - shown.length)}`}</Chip>
        </Show>
      </>
    );
  };

  const record = (client: ClientRow) => (
    <Pane
      detail
      label={client.name}
      back={{ label: t().backToClients, href: LIST }}
      head={<Bar start={<Text type="lead">{client.name}</Text>} end={<Button variant="ghost" icon="x" label={t().close} href={LIST} />} />}
    >
      <Show when={client.groups.length === 0}>
        <Notice tone="warn">{t().blockedUntilConfigured}</Notice>
      </Show>
      <Facts
        items={[
          { label: t().verifyUrl, value: verifyUrl(client.clientId), mono: true, copy: verifyUrl(client.clientId) },
          { label: t().clientId, value: client.clientId, mono: true, copy: client.clientId },
          { label: t().description, value: client.description || t().noDescription },
          { label: t().allowedGroups, value: <>{groupChips(client)}</> },
          { label: t().created, value: client.created },
        ]}
      />
      <Bar
        end={
          <>
            <Button icon="trash" onClick={() => void remove(client)}>
              {t().delete}
            </Button>
            <Button icon="pencil" onClick={() => start(client)}>
              {t().edit}
            </Button>
          </>
        }
      />
    </Pane>
  );

  /** The clients with their figures, one open beside them. */
  const list = () => (
    <Pane.Split>
      <Pane
        label={t().appName}
        scrollKey="proxy-auth-clients"
        status={
          <StatusRow
            lead={props.figures.withoutGroups > 0 ? t().blockedLead({ count: props.figures.withoutGroups }) : t().allGatedLead}
            filters={
              props.figures.withoutGroups > 0 ? (
                <Chip status="warn" icon="lock">
                  {t().blockedUntilConfigured}
                </Chip>
              ) : undefined
            }
          />
        }
      >
        <Cells>
          <Cells.Cell icon="shield-half" label={t().clients} value={number(props.clients.length)} meta={t().registered} />
          <Cells.Cell icon="users-group" label={t().allowedGroups} value={number(props.figures.groups)} meta={t().acrossClients} />
          <Cells.Cell
            icon={props.figures.withoutGroups > 0 ? "alert-triangle" : "check"}
            label={t().noGroups}
            value={props.figures.withoutGroups > 0 ? <Text tone="warn">{number(props.figures.withoutGroups)}</Text> : "0"}
            meta={props.figures.withoutGroups > 0 ? t().blockedUntilConfigured : t().allGated}
          />
        </Cells>
        <Table
          label={t().clients}
          rows={props.clients}
          rowKey={(client) => client.id}
          sticky
          current={props.open ?? undefined}
          open={(client) => ({ href: `${LIST}?client=${encodeURIComponent(client.id)}` })}
          empty={{ icon: "shield-half", text: t().empty, action: { label: t().newClient, icon: "plus", onClick: () => start("new") } }}
          phone={(client) => ({
            lines: [client.name, client.description || client.clientId],
            time: client.created,
            marks: client.groups.length === 0 ? <Chip status="warn">{t().noGroups}</Chip> : undefined,
          })}
          columns={[
            {
              title: t().client,
              width: { min: 200, default: 320 },
              cell: (client) => ({ lines: [client.name, client.description || t().noDescription] }),
            },
            {
              title: t().allowedGroups,
              width: { min: 160, default: 280 },
              cell: (client) => <>{groupChips(client, true)}</>,
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
            <Pane detail label={t().clients} back={{ label: t().backToClients, href: LIST }}>
              <Empty icon="file-off" text={t().notFound} action={{ label: t().backToClients, href: LIST }} />
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
      <Section icon="route" title={t().setupTitle} summary={t().setupDescription}>
        <Facts items={[{ label: t().verifyUrlPattern, value: `${props.baseUrl}/proxy-auth/verify/<client-id>`, mono: true }]} />
        <Prose
          markdown={[
            `**${t().exampleConfiguration}**`,
            "",
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
        <Text weight="strong">{t().responseHeaders}</Text>
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
      // the main action: in the head on a wide screen, floating at the bottom right on the phone
      primary={{ label: t().newClient, icon: "plus", onClick: () => start("new") }}
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
            <Button variant="primary" icon="plus" onClick={() => start("new")}>
              {t().newClient}
            </Button>
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
            <Button icon="check" busy={busy()} onClick={() => void save()}>
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
        foot={<Button onClick={() => location.reload()}>{t().close}</Button>}
      >
        <Text>{t().copyLater}</Text>
        <Facts items={[{ label: t().verifyUrl, value: verifyUrl(created() ?? ""), mono: true, copy: verifyUrl(created() ?? "") }]} />
      </Dialog>
    </AdminWorkspace>
  );
}
