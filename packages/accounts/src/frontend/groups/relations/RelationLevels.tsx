import type { GroupRelations } from "@k2b/cloud/contracts";
import { For, Match, Show, Switch } from "solid-js";
import type { RelationsText } from "./relations-messages";
import { LEVELS, layoutLevels, type RelationsUrlState } from "./relations-view";

type Props = {
  relations: GroupRelations;
  state: RelationsUrlState;
  t: RelationsText;
  /** The address of this view with a change, such as another chosen group. */
  href: (change: Partial<RelationsUrlState>) => string;
};

const card =
  "box-border block w-full overflow-hidden rounded-[var(--k2-r-control)] px-2 py-[7px] text-[13px] leading-[17px] outline-offset-1 hover:bg-[var(--k2-n100)] focus-visible:outline-2 focus-visible:outline-[var(--k2-blue)] md:w-[172px]";
const line = "block truncate";
const meta = "block truncate text-[11.5px] leading-[16px] text-[var(--k2-subtle)]";

/**
 * Levels around the focus: containing groups to the left, contained groups to the right, each group once.
 * Every card has a fixed height, so server and browser draw the same edges without measuring. On narrow screens the
 * columns stack and the edges are left out; the details and the list carry the same relations.
 */
export default function RelationLevels(props: Props) {
  const layout = () => layoutLevels(props.relations);
  const node = (id: string) => props.relations.nodes.find((entry) => entry.id === id);
  const name = (id: string) => node(id)?.name ?? id;
  // The focus carries its own tint; only a group chosen besides it gets the selection ring.
  const selected = () => props.state.sel;
  const title = (column: ReturnType<typeof layoutLevels>["columns"][number]) =>
    column.direction === "focus"
      ? props.t.columnFocus
      : column.direction === "up"
        ? props.t.columnUp({ level: column.level })
        : props.t.columnDown({ level: column.level });
  return (
    <div class="relative min-h-full md:min-w-max" style={{ "min-height": `${layout().height}px` }}>
      <svg
        class="pointer-events-none absolute top-0 left-0 hidden overflow-visible md:block"
        width={layout().width}
        height={layout().height}
        aria-hidden="true"
      >
        <defs>
          <marker id="relations-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0L8 4L0 8z" fill="var(--k2-warn-ink)" />
          </marker>
        </defs>
        <For each={layout().paths}>
          {(path) => (
            <path
              d={path.d}
              fill="none"
              stroke={path.cycle ? "var(--k2-warn-ink)" : "var(--k2-n400)"}
              stroke-width="1.5"
              stroke-dasharray={path.cycle ? "5 4" : undefined}
              marker-end={path.arrow ? "url(#relations-arrow)" : undefined}
            />
          )}
        </For>
      </svg>
      <div
        class="relative flex flex-col gap-4 p-3 md:flex-row md:items-start md:gap-[40px] md:px-[16px] md:pb-[16px]"
        style={{ "padding-top": `${LEVELS.padTop}px` }}
      >
        <For each={layout().columns}>
          {(column) => (
            <section class="flex w-full flex-col gap-[4px] md:w-[172px]" aria-label={title(column)}>
              <h2 class="h-[20px] truncate text-xs font-semibold leading-[20px] text-[var(--k2-subtle)]">{title(column)}</h2>
              <For each={column.entries}>
                {(entry) => (
                  <Switch>
                    <Match when={entry.kind === "group" && entry}>
                      {(group) => {
                        const current = () => node(group().id);
                        return (
                          <a
                            href={props.href({ sel: group().id })}
                            class={`${card} ${group().focus ? "bg-[var(--k2-app-tint)] text-[var(--k2-app-text)]" : "bg-[var(--k2-surface)] text-[var(--k2-text)]"} ${selected() === group().id ? "outline-2 outline-[var(--k2-app-text)]" : ""}`}
                            style={{ height: `${group().height}px` }}
                            aria-current={selected() === group().id ? "true" : undefined}
                          >
                            <span class={`${line} font-medium`}>{current()?.name ?? group().id}</span>
                            <span class={meta}>
                              {props.t.meta({
                                ipa: current()?.provider === "ipa",
                                contains: current()?.contains ?? 0,
                                members: current()?.members ?? 0,
                              })}
                            </span>
                            <Show when={current()?.inCycle}>
                              <span class={`${meta} font-medium text-[var(--k2-warn-ink)]`}>{props.t.inCycle}</span>
                            </Show>
                          </a>
                        );
                      }}
                    </Match>
                    <Match when={entry.kind === "back" && entry}>
                      {(back) => {
                        const up = column.direction === "up";
                        const text = () =>
                          back().closesCycle
                            ? (up ? props.t.backUp : props.t.backDown)({ name: name(back().from) })
                            : (up ? props.t.shownUp : props.t.shownDown)({ name: name(back().from) });
                        return (
                          <a
                            href={props.href({ sel: back().to })}
                            class={`${card} ${back().closesCycle ? "bg-[var(--k2-warn-tint)] text-[var(--k2-warn-ink)]" : "bg-[var(--k2-surface)] text-[var(--k2-muted)]"} ${selected() === back().to ? "outline-2 outline-[var(--k2-app-text)]" : ""}`}
                            style={{ height: `${back().height}px` }}
                            aria-label={`${name(back().to)}: ${text()}`}
                          >
                            <span class={`${line} font-medium`}>
                              {back().closesCycle ? "↺" : "↪"} {name(back().to)}
                            </span>
                            <span class={`${line} text-[11.5px] leading-[16px] ${back().closesCycle ? "" : "text-[var(--k2-subtle)]"}`}>
                              {text()}
                            </span>
                          </a>
                        );
                      }}
                    </Match>
                    <Match when={entry.kind === "more" && entry}>
                      {(more) => (
                        <a
                          href={props.href({ expand: [...props.state.expand, more().key] })}
                          class="flex items-center rounded-[var(--k2-r-control)] px-2 text-[12.5px] text-[var(--k2-app-text)] hover:bg-[var(--k2-n100)] focus-visible:outline-2 focus-visible:outline-[var(--k2-blue)]"
                          style={{ height: `${more().height}px` }}
                        >
                          {props.t.more({ count: more().count })}
                        </a>
                      )}
                    </Match>
                  </Switch>
                )}
              </For>
            </section>
          )}
        </For>
      </div>
      <Show when={props.relations.columns.length === 0}>
        <p class="px-4 pb-4 text-xs text-[var(--k2-subtle)]">{props.t.noRelations}</p>
      </Show>
    </div>
  );
}
