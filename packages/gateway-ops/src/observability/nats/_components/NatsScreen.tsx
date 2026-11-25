import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Facts,
  FilterBar,
  Input,
  List,
  Notice,
  Pane,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, For, Show } from "solid-js";
import { NatsSyncViewTabs, type ObservabilityAreaNav, ObservabilityNav } from "../../_components/ObservabilityNav";
import { listHref, type NatsListState, natsQuery, type SyncNatsFacets } from "../../_components/sync-nats-query";
import { natsMessages } from "../messages";

const PATH = "/admin/observability/nats";

/** A worded state with its tone; no tone is a plain chip. */
export type Worded = { label: string; status: "ok" | "warn" | "bad" | null };
export type NatsNotice = { tone: "note" | "warn"; title: string; text?: string };

export type NatsNodeRow = {
  id: string;
  name: string;
  version: string;
  state: Worded;
  leader: string;
  storage: string;
  memory: string;
  streams: string;
};
export type NatsStreamRow = {
  name: string;
  kind: string;
  owner: { label: string; href: string } | null;
  messages: string;
  /** Messages of a dead-letter stream, worded and toned. */
  deadLetters: Worded | null;
  storage: string;
  retention: string;
  replicas: string;
  replicaState: Worded | null;
  consumers: string;
  problem: boolean;
  href: string;
};
export type NatsConsumerRow = { name: string; numbers: string; leader: string; replicas: Worded | null };

export type NatsScreenProps = {
  area: ObservabilityAreaNav;
  facets: SyncNatsFacets;
  state: NatsListState;
  /** Parameters of the address that did not apply, already worded. */
  ignored: string | null;
  sampledAt: string;
  refreshHref: string;
  clusterNotice: NatsNotice | null;
  nodes: NatsNodeRow[];
  inventoryNotice: NatsNotice | null;
  streams: NatsStreamRow[];
  streamsTotal: string;
  facts: { problems: string; deadLetters: string; replication: string; partial: boolean };
  previousHref: string | null;
  nextHref: string | null;
  /** The stream open beside the list, with its consumers. */
  stream: {
    name: string;
    row: NatsStreamRow | null;
    consumers: NatsConsumerRow[];
    firstHref: string | null;
    nextHref: string | null;
    closeHref: string;
  } | null;
};

export const worded = (value: Worded | null) =>
  value === null ? <Text muted>—</Text> : value.status ? <Chip status={value.status}>{value.label}</Chip> : <Chip>{value.label}</Chip>;

/** NATS diagnostics on v2: cluster nodes, the account's streams with their filters, and one stream's consumers beside. */
export default function NatsScreen(props: NatsScreenProps) {
  const locale = useLocale();
  const t = () => natsMessages.resolve([locale()]).t;
  const query = createMemo(() =>
    natsQuery(locale(), props.facets, { app: props.state.filters.app, namespace: props.state.filters.namespace }),
  );
  // A filter reloads the page from the server, which filters the bounded account scan; the bar wrote the address.
  const change = (next: NatsListState) => location.replace(listHref(PATH, query().serialize(next)));
  const search = (text: string) => location.assign(listHref(PATH, query().serialize({ ...props.state, search: text.trim() || undefined })));
  const changed = () => query().serialize(props.state).size > 0;

  return (
    <Workspace
      sidebar={<ObservabilityNav area={props.area} current="nats" />}
      detail={props.stream ? 420 : undefined}
      head={
        <Bar
          start={<NatsSyncViewTabs current="nats" />}
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().resourceFilter}
                placeholder={t().resourceFilter}
                value={props.state.search ?? ""}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) search("");
                }}
              />
              <Button variant="ghost" icon="refresh" label={t().refresh} title={t().refresh} href={props.refreshHref} />
            </>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().streams}
          scrollKey="gateway-ops-nats"
          status={
            <>
              <FilterBar
                query={query()}
                state={props.state}
                onChange={(next) => change({ ...props.state, filters: next.filters, search: next.search })}
                icons={{ app: "apps", namespace: "folders", state: "alert-triangle" }}
                results={t().streamsCount({ count: props.streamsTotal })}
              />
              <StatusRow
                lead={t().streamsCount({ count: props.streamsTotal })}
                facts={[
                  { value: props.facts.problems, after: t().problemStreams },
                  { value: props.facts.deadLetters, after: t().deadLetterStreams },
                  { value: props.facts.replication, after: t().replicationProblems },
                  ...(props.facts.partial ? [{ after: t().partial }] : []),
                ]}
              />
            </>
          }
        >
          <Show when={props.ignored}>
            {(text) => (
              <Notice tone="warn" title={t().invalidFilters}>
                {text()}
              </Notice>
            )}
          </Show>
          <Show when={props.clusterNotice}>
            {(notice) => (
              <Notice tone={notice().tone} title={notice().title}>
                {notice().text}
              </Notice>
            )}
          </Show>
          <Section icon="server" title={t().cluster} count={props.nodes.length} summary={t().nodeScope}>
            <Table
              label={t().cluster}
              rows={props.nodes}
              rowKey={(row) => row.id}
              empty={{ icon: "server-off", text: t().empty }}
              phone={(row) => ({ lines: [row.name, `${row.version} · ${row.storage}`], marks: worded(row.state) })}
              columns={
                props.stream
                  ? [
                      { title: t().name, width: { min: 120, default: 160 }, cell: (row) => row.name },
                      { title: t().metadataStatus, width: { min: 140, default: 170 }, cell: (row) => worded(row.state) },
                      { title: t().storage, cell: (row) => row.storage },
                    ]
                  : [
                      { title: t().name, width: { min: 110, default: 140 }, cell: (row) => ({ lines: [row.name, row.version] }) },
                      { title: t().metadataStatus, width: { min: 140, default: 170 }, cell: (row) => worded(row.state) },
                      { title: t().leader, width: { min: 90, default: 110 }, cell: (row) => row.leader, drop: true },
                      { title: t().storage, width: { min: 140, default: 180 }, cell: (row) => row.storage, drop: true },
                      { title: t().memory, width: { min: 80, default: 90 }, align: "end", cell: (row) => row.memory, drop: true },
                      { title: t().streams, align: "end", cell: (row) => row.streams, drop: true },
                    ]
              }
            />
          </Section>
          <Show when={props.inventoryNotice}>
            {(notice) => (
              <Notice tone={notice().tone} title={notice().title}>
                {notice().text}
              </Notice>
            )}
          </Show>
          <Section icon="database" title={t().streams} count={props.streamsTotal} summary={t().accountScope}>
            <Table
              label={t().streams}
              rows={props.streams}
              rowKey={(row) => row.name}
              current={props.stream?.name}
              open={(row) => ({ href: row.href })}
              empty={
                changed()
                  ? { icon: "filter-off", text: t().noMatches, action: { label: t().clearFilters, icon: "filter-off", href: PATH } }
                  : { icon: "database-off", text: t().empty }
              }
              phone={(row) => ({
                lines: [row.name, [row.kind, row.messages, row.storage].join(" · ")],
                marks: row.deadLetters ? worded(row.deadLetters) : row.replicaState ? worded(row.replicaState) : undefined,
              })}
              columns={
                props.stream
                  ? [
                      { title: t().name, width: { min: 160, default: 240 }, cell: (row) => ({ lines: [row.name, row.kind] }) },
                      {
                        title: t().messages,
                        width: { min: 100, default: 130 },
                        align: "end",
                        cell: (row) => (row.deadLetters ? worded(row.deadLetters) : row.messages),
                      },
                      { title: t().replicas, cell: (row) => (row.replicaState ? worded(row.replicaState) : row.replicas) },
                    ]
                  : [
                      {
                        title: t().name,
                        width: { min: 160, default: 220 },
                        cell: (row) => ({ lines: [row.name, row.owner?.label ?? row.kind] }),
                      },
                      {
                        title: t().messages,
                        width: { min: 100, default: 130 },
                        align: "end",
                        cell: (row) => (row.deadLetters ? worded(row.deadLetters) : row.messages),
                      },
                      { title: t().storage, width: { min: 140, default: 180 }, cell: (row) => row.storage, drop: true },
                      { title: t().retention, width: { min: 80, default: 90 }, cell: (row) => row.retention, drop: true },
                      {
                        title: t().replicas,
                        width: { min: 130, default: 160 },
                        cell: (row) => (row.replicaState ? worded(row.replicaState) : row.replicas),
                        drop: true,
                      },
                      { title: t().consumers, align: "end", cell: (row) => row.consumers, drop: true },
                    ]
              }
            />
          </Section>
          <Show when={props.previousHref || props.nextHref}>
            <Bar
              end={
                <>
                  <Button icon="chevron-left" href={props.previousHref ?? undefined} disabled={!props.previousHref}>
                    {t().previous}
                  </Button>
                  <Button href={props.nextHref ?? undefined} disabled={!props.nextHref} forward>
                    {t().next}
                  </Button>
                </>
              }
            />
          </Show>
        </Pane>
        <Show when={props.stream}>{(stream) => <StreamPane stream={stream()} />}</Show>
      </Pane.Split>
    </Workspace>
  );
}

/** One stream beside the list: what it holds and its consumers with their backlog. */
function StreamPane(props: { stream: NonNullable<NatsScreenProps["stream"]> }) {
  const locale = useLocale();
  const t = () => natsMessages.resolve([locale()]).t;
  const row = () => props.stream.row;
  return (
    <Pane
      detail
      label={props.stream.name}
      back={{ label: t().streams, href: props.stream.closeHref }}
      head={
        <Bar
          start={<Text type="lead">{props.stream.name}</Text>}
          end={<Button variant="ghost" icon="x" label={t().close} href={props.stream.closeHref} />}
        />
      }
    >
      <Show when={row()}>
        {(open) => (
          <Section icon="database" title={t().stream}>
            <Facts
              items={[
                { label: t().name, value: open().name, mono: true, copy: open().name },
                { label: t().kind, value: open().kind },
                { label: t().messages, value: open().deadLetters ? worded(open().deadLetters) : open().messages },
                { label: t().storage, value: open().storage },
                { label: t().retention, value: open().retention },
                { label: t().replicas, value: open().replicaState ? worded(open().replicaState) : open().replicas },
                ...(open().owner ? [{ label: t().owner, value: <Text href={open().owner?.href}>{open().owner?.label}</Text> }] : []),
              ]}
            />
          </Section>
        )}
      </Show>
      <Section icon="users" title={t().consumers} count={props.stream.consumers.length} summary={t().consumerScope}>
        <Show when={props.stream.consumers.length > 0} fallback={<Text muted>{t().empty}</Text>}>
          <List label={t().consumers}>
            <For each={props.stream.consumers}>
              {(consumer) => (
                <Row
                  lines={[consumer.name, consumer.numbers]}
                  meta={consumer.leader}
                  end={consumer.replicas ? worded(consumer.replicas) : undefined}
                />
              )}
            </For>
          </List>
        </Show>
      </Section>
      <Show when={props.stream.firstHref || props.stream.nextHref}>
        <Bar
          end={
            <>
              <Button href={props.stream.firstHref ?? undefined} disabled={!props.stream.firstHref}>
                {t().first}
              </Button>
              <Button href={props.stream.nextHref ?? undefined} disabled={!props.stream.nextHref} forward>
                {t().next}
              </Button>
            </>
          }
        />
      </Show>
    </Pane>
  );
}
