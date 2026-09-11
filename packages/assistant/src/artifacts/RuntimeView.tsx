import { For, Switch, Match, Show, createMemo, createEffect, type JSX } from "solid-js";
import {
  Chart,
  Button,
  ButtonLink,
  TextInput,
  Select,
  DataTable,
  ProgressBar,
  Placeholder,
  SettingsGroup,
  SettingsCollection,
  MarkdownView,
  useLocale,
} from "@k2b/ui";
import { createStore, reconcile } from "solid-js/store";
import { artifactMessages as messages } from "./messages";
import type { UiNode, RuntimeEvent } from "./runtime/protocol";
export function RuntimeView(props: { nodes: UiNode[]; busy: boolean; event: (event: RuntimeEvent) => void }) {
  const locale = useLocale(),
    t = () => messages.resolve([locale()]).t;
  const by = createMemo(() => new Map(props.nodes.map((n) => [n.id, n])));
  const roots = createMemo(() => {
    const children = new Set(props.nodes.flatMap((n) => n.children));
    return props.nodes.filter((n) => !children.has(n.id));
  });
  // Keep each keyed child list mounted across structured-cloned worker snapshots.
  function Children(p: { ids: string[] }) {
    return <For each={p.ids}>{(id) => <NodeView id={id} />}</For>;
  }
  function TableView(p: { node: UiNode }) {
    const [data, setData] = createStore({ rows: p.node.rows, columns: p.node.columns });
    createEffect(() => {
      setData("rows", reconcile(p.node.rows, { key: p.node.rowKey ?? null }));
      setData("columns", reconcile(p.node.columns, { key: "key" }));
    });
    return (
      <DataTable
        rows={data.rows}
        columns={data.columns.map((c) => ({ id: c.key, header: c.label, value: c.key, align: c.align }))}
        getRowId={p.node.rowKey ? (row) => `${typeof row[p.node.rowKey!]}:${row[p.node.rowKey!]}` : undefined}
        ariaLabel={p.node.label || t().results}
        density="normal"
      />
    );
  }
  function NodeView(p: { id: string }): JSX.Element {
    const n = () => by().get(p.id)!;
    const disabled = () => props.busy || n().disabled || n().loading;
    const icon = () => (
      <Show when={n().icon}>
        <i class={n().icon} aria-hidden="true" />
      </Show>
    );
    const empty = () => (
      <Placeholder
        state={n().loading || n().state === "loading" ? "loading" : n().state === "error" ? "error" : "empty"}
        align="left"
        variant="panel"
        title={n().state === "error" ? n().description : n().empty?.title}
        description={n().state === "error" ? undefined : n().empty?.description}
        icon={n().state === "error" ? "ti ti-alert-circle" : "ti ti-table"}
      />
    );
    return (
      <div data-artifact-id={p.id} class={`artifact-node artifact-node-${n().kind}`}>
        <Switch>
          <Match when={n().kind === "text"}>
            <p class="whitespace-pre-wrap">{n().label}</p>
          </Match>
          <Match when={n().kind === "status"}>
            <span class="artifact-status" role="status" data-state={n().state}>
              {n().description || n().label}
            </span>
          </Match>
          <Match when={n().kind === "markdown"}>
            <MarkdownView
              markdown={n().value}
              headingScale={n().headingScale}
              allowImages={false}
              linkProtocols={["http:", "https:", "mailto:"]}
              linkTarget="_blank"
            />
          </Match>
          <Match when={n().kind === "button"}>
            <Button
              aria-label={n().label}
              variant={n().variant}
              disabled={disabled()}
              loading={n().loading}
              onClick={() => props.event({ id: p.id })}
            >
              {icon()}
              {n().label}
            </Button>
          </Match>
          <Match when={n().kind === "link" || n().kind === "linkButton"}>
            <Show when={n().link}>
              {(link) => (
                <ButtonLink
                  aria-label={n().label}
                  href={disabled() ? undefined : link().href}
                  aria-disabled={disabled()}
                  target={link().newTab ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  variant={n().kind === "link" ? "text" : n().variant}
                >
                  {icon()}
                  {n().label}
                </ButtonLink>
              )}
            </Show>
          </Match>
          <Match when={n().kind === "input"}>
            <TextInput
              label={n().label}
              description={n().description || undefined}
              placeholder={n().placeholder}
              value={n().value}
              disabled={disabled()}
              onValueChange={(v) => props.event({ id: p.id, value: v ?? "" })}
            />
          </Match>
          <Match when={n().kind === "select"}>
            <Select
              label={n().label}
              value={n().value}
              options={n().options}
              disabled={disabled()}
              onValueChange={(v) => props.event({ id: p.id, value: v ?? "" })}
            />
          </Match>
          <Match when={n().kind === "filePicker"}>
            <div class="artifact-file-picker">
              <i class={n().icon || "ti ti-file-type-csv"} aria-hidden="true" />
              <div class="artifact-file-info">
                <strong>{n().value || n().label}</strong>
                <Show when={n().description}>
                  <p>{n().description}</p>
                </Show>
              </div>
              <Button
                aria-label={n().label}
                variant={n().value ? "secondary" : "primary"}
                disabled={disabled()}
                loading={n().loading}
                onClick={() => props.event({ id: p.id })}
              >
                <i class="ti ti-upload" aria-hidden="true" />
                {n().label}
              </Button>
            </div>
          </Match>
          <Match when={n().kind === "chart"}>
            <Show when={n().chart}>
              {(options) => <Chart {...options()} style={{ height: options().kind === "sparkline" ? "4rem" : "18rem" }} />}
            </Show>
          </Match>
          <Match when={n().kind === "table"}>
            <Show when={n().rows.length > 0 && n().state === "ready" && !n().loading} fallback={empty()}>
              <TableView node={n()} />
            </Show>
          </Match>
          <Match when={n().kind === "list"}>
            <SettingsCollection
              title={n().label}
              description={n().description || undefined}
              empty={<Placeholder state="empty" align="left" title={n().empty?.title} description={n().empty?.description} />}
            >
              <For each={n().items.map((item) => item.id)}>
                {(id) => {
                  const item = () => n().items.find((item) => item.id === id)!;
                  return (
                    <SettingsCollection.Item
                      title={item().title}
                      description={item().description}
                      icon={<i class={item().icon || "ti ti-file"} aria-hidden="true" />}
                    >
                      <SettingsCollection.Item.Actions>
                        <For each={n().actions}>{(action) => (
                          <Button variant={action.variant ?? "ghost"} disabled={disabled()}
                            onClick={() => props.event({ id: p.id, action: action.id, item: id })}>
                            <Show when={action.icon}><i class={action.icon} aria-hidden="true" /></Show>{action.label}
                          </Button>
                        )}</For>
                      </SettingsCollection.Item.Actions>
                    </SettingsCollection.Item>
                  );
                }}
              </For>
            </SettingsCollection>
          </Match>
          <Match when={n().kind === "progress"}>
            <ProgressBar label={n().label || t().progress} value={n().progress * 100} />
          </Match>
          <Match when={n().kind === "section"}>
            <SettingsGroup title={n().label} description={n().description || undefined}>
              <div class="artifact-flow artifact-flow-column artifact-gap-md">
                <Children ids={n().children} />
              </div>
            </SettingsGroup>
          </Match>
          <Match when={n().kind === "workbench"}>
            <div class="artifact-runtime-workbench" classList={{ "artifact-runtime-workbench-full": !n().controls.length }}>
              <Show when={n().controls.length}>
                <aside class="artifact-runtime-controls">
                  <Children ids={n().controls} />
                </aside>
              </Show>
              <div class="artifact-runtime-main">
                <div class="artifact-runtime-content">
                  <Children ids={n().content} />
                </div>
              </div>
              <Show when={n().footer}>
                {(footer) => (
                  <footer class="artifact-runtime-footer">
                    <div>
                      <Show when={footer().status}>{(status) => <NodeView id={status()} />}</Show>
                    </div>
                    <div class="artifact-flow artifact-flow-row artifact-gap-sm">
                      <Children ids={footer().actions} />
                    </div>
                  </footer>
                )}
              </Show>
            </div>
          </Match>
          <Match when={n().kind === "row" || n().kind === "column"}>
            <div class={`artifact-flow artifact-flow-${n().kind} artifact-gap-${n().gap}`}>
              <Children ids={n().children} />
            </div>
          </Match>
        </Switch>
      </div>
    );
  }
  return (
    <div class="artifact-runtime-root">
      <Children ids={roots().map((node) => node.id)} />
    </div>
  );
}
