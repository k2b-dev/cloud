import { For, Switch, Match, Show, createMemo, type JSX } from "solid-js";
import {
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
import { messages } from "./messages";
import type { UiNode } from "../runtime/protocol";
export function RuntimeView(props: { nodes: UiNode[]; busy: boolean; event: (id: string, value?: string) => void }) {
  const locale = useLocale(),
    t = () => messages.resolve([locale()]).t;
  const by = createMemo(() => new Map(props.nodes.map((n) => [n.id, n])));
  const roots = createMemo(() => {
    const children = new Set(props.nodes.flatMap((n) => n.children));
    return props.nodes.filter((n) => !children.has(n.id));
  });
  const children = (ids: string[]) => <For each={ids}>{(id) => <NodeView id={id} />}</For>;
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
      <div data-kit-id={p.id} class={`kit-node kit-node-${n().kind}`}>
        <Switch>
          <Match when={n().kind === "text"}>
            <p class="whitespace-pre-wrap">{n().label}</p>
          </Match>
          <Match when={n().kind === "status"}>
            <span class="kit-status" role="status" data-state={n().state}>
              {n().label}
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
              onClick={() => props.event(p.id)}
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
              onValueChange={(v) => props.event(p.id, v ?? "")}
            />
          </Match>
          <Match when={n().kind === "select"}>
            <Select
              label={n().label}
              value={n().value}
              options={n().options}
              disabled={disabled()}
              onValueChange={(v) => props.event(p.id, v ?? "")}
            />
          </Match>
          <Match when={n().kind === "filePicker"}>
            <div class="kit-file-picker">
              <i class={n().icon || "ti ti-file-type-csv"} aria-hidden="true" />
              <div class="kit-file-info">
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
                onClick={() => props.event(p.id)}
              >
                <i class="ti ti-upload" aria-hidden="true" />
                {n().label}
              </Button>
            </div>
          </Match>
          <Match when={n().kind === "table"}>
            <Show when={n().rows.length > 0 && n().state === "ready" && !n().loading} fallback={empty()}>
              <DataTable
                rows={n().rows}
                columns={n().columns.map((c) => ({
                  id: c.key,
                  header: c.label,
                  value: c.key,
                  align: c.align,
                }))}
                ariaLabel={n().label || t().results}
                density="normal"
              />
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
                        <Show when={item().action}>{(action) => <NodeView id={action()} />}</Show>
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
              <div class="kit-flow kit-flow-column kit-gap-md">{children(n().children)}</div>
            </SettingsGroup>
          </Match>
          <Match when={n().kind === "workbench"}>
            <div class="kit-runtime-workbench">
              <aside class="kit-runtime-controls">{children(n().controls)}</aside>
              <div class="kit-runtime-main">
                <div class="kit-runtime-content">{children(n().content)}</div>
              </div>
              <Show when={n().footer}>
                {(footer) => (
                  <footer class="kit-runtime-footer">
                    <div>
                      <Show when={footer().status}>{(status) => <NodeView id={status()} />}</Show>
                    </div>
                    <div class="kit-flow kit-flow-row kit-gap-sm">{children(footer().actions)}</div>
                  </footer>
                )}
              </Show>
            </div>
          </Match>
          <Match when={n().kind === "row" || n().kind === "column"}>
            <div class={`kit-flow kit-flow-${n().kind} kit-gap-${n().gap}`}>{children(n().children)}</div>
          </Match>
        </Switch>
      </div>
    );
  }
  return <div class="kit-runtime-root">{children(roots().map((node) => node.id))}</div>;
}
