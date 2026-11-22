import { children, createSignal, createUniqueId, type JSX, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";
import { IconButton } from "../actions/Button";
import { rendersSomething } from "../internal/renders-something";
import { useFlatBlockMessages } from "./flat-block-messages";

export type AreaProps = Omit<JSX.HTMLAttributes<HTMLElement>, "children" | "title"> & {
  /** The thing's name, such as "Stack 2". */
  name: string;
  /** Makes the name a link to the thing's own page, such as a delivery's record. */
  href?: string;
  /** A short number or code in the 20 px tile before the name, such as "2". Pass `icon` instead for a symbol. */
  marker?: string | number;
  /** A Tabler icon class for the tile, when the area has no number. */
  icon?: string;
  /** The area's own state, such as a `StatusBadge`, right after the name; it stays in the closed row too. */
  state?: JSX.Element;
  /** How many rows hang on the area; the closed row shows it after the name. */
  count?: number;
  /** The area's own actions at the right of its head, such as framed `Button`s and icon buttons. Hidden while closed. */
  actions?: JSX.Element;
  /** One 12 px meta line under the name, such as "3 lists · 2 of 3 photographed". Hidden while closed. */
  meta?: JSX.Element;
  /** The rows that hang on the area, or one more `Area` (at most two levels). Never a `RowGroup`. */
  children?: JSX.Element;
  /** What an area without rows says, such as "No list yet"; an area exists also when it is empty. */
  empty?: JSX.Element;
  /** Lets the person close the area to one 40 px row. Only the person opens or closes it. */
  collapsible?: boolean;
  open?: boolean;
  /** Defaults to open. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Heading level of the name; defaults to 4. */
  level?: 3 | 4 | 5;
};

/**
 * An area (K17 "Bereich"): a thing the rows hang on, such as a stack with its lists. Open, it is a square area of its
 * own with a 56 px head of two lines (tile, name in 14 px with its state beside it, actions at the right, a 12 px meta
 * line) and its rows on a rail that starts on the name's text edge; two areas share one line (`--k2b-gap-area`, 0 by default). Closed, it is one 40 px row like a list
 * row: name, state, count, and the chevron, without a surface or a gap. Take an area over a `RowGroup` when it exists
 * also empty, has a state of its own, or two or more actions of its own.
 */
export function Area(props: AreaProps): JSX.Element {
  const [local, rest] = splitProps(props, [
    "name",
    "href",
    "marker",
    "icon",
    "state",
    "count",
    "actions",
    "meta",
    "children",
    "empty",
    "collapsible",
    "open",
    "defaultOpen",
    "onOpenChange",
    "level",
    "class",
  ]);
  const t = useFlatBlockMessages();
  const id = `k2b-area-${createUniqueId()}`;
  const [internalOpen, setInternalOpen] = createSignal(local.defaultOpen ?? true);
  const open = () => !local.collapsible || (local.open ?? internalOpen());
  const toggle = () => {
    const next = !open();
    if (local.open === undefined) setInternalOpen(next);
    local.onOpenChange?.(next);
  };
  const rows = children(() => local.children);
  const hasRows = () => rendersSomething(rows.toArray());
  /** A click on the head's free space toggles too; its own controls keep their click. */
  const onHeadClick = (event: MouseEvent) => {
    if (!local.collapsible || (event.target as Element).closest("button, a, input, select, textarea, label, [role='button']")) return;
    toggle();
  };
  return (
    <section
      {...rest}
      class={local.class ? `k2b-area ${local.class}` : "k2b-area"}
      data-open={String(open())}
      data-collapsible={local.collapsible ? "true" : undefined}
      aria-labelledby={`${id}-name`}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the chevron button is the keyboard and screen-reader control; the head's free space is a larger pointer target for the same toggle. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
      <div class="k2b-area__head" onClick={onHeadClick}>
        <span class="k2b-area__tile" aria-hidden="true">
          <Show when={local.icon} fallback={local.marker}>
            {(icon) => <i class={icon()} />}
          </Show>
        </span>
        <div class="k2b-area__title">
          <Dynamic component={`h${local.level ?? 4}`} id={`${id}-name`} class="k2b-area__name">
            <Show when={local.href} fallback={local.name}>
              {(href) => (
                <a class="k2b-area__link" href={href()}>
                  {local.name}
                </a>
              )}
            </Show>
          </Dynamic>
          <Show when={local.count !== undefined && !open()}>
            <span class="k2b-area__count">{local.count}</span>
          </Show>
          <Show when={local.state}>
            <span class="k2b-area__state">{local.state}</span>
          </Show>
        </div>
        <div class="k2b-area__end">
          <Show when={open() && local.actions}>
            <div class="k2b-area__actions">{local.actions}</div>
          </Show>
        </div>
        <Show when={local.collapsible}>
          <IconButton
            size="sm"
            variant="ghost"
            class="k2b-area__chevron"
            label={open() ? t().hideArea({ name: local.name }) : t().showArea({ name: local.name })}
            aria-expanded={open()}
            aria-controls={`${id}-body`}
            onClick={toggle}
          >
            <i class={open() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
          </IconButton>
        </Show>
        <Show when={open() && local.meta}>
          <div class="k2b-area__meta">{local.meta}</div>
        </Show>
      </div>
      <div class="k2b-area__body k2b-divided" id={`${id}-body`} hidden={!open()}>
        <Show when={hasRows()} fallback={<Show when={local.empty}>{(empty) => <p class="k2b-area__empty">{empty()}</p>}</Show>}>
          {rows()}
        </Show>
      </div>
    </section>
  );
}

export default Area;
