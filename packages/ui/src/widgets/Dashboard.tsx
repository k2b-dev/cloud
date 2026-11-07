import { createUniqueId, type JSX, Show, splitProps } from "solid-js";
import { Dynamic } from "solid-js/web";

/**
 * A panel's share of the six dashboard columns: a third is two, a half three, two thirds four, full all six. At a
 * dashboard width of 1000 px or less a third takes half the row and two thirds the whole row; at 600 px or less every
 * panel takes the whole row.
 */
export type DashboardWidth = "third" | "half" | "twoThirds" | "full";

export type DashboardGridProps = {
  children: JSX.Element;
  class?: string;
};

/** The dashboard's measuring container. Panel widths and the key-figure row follow its width, not the window's. */
export function DashboardGrid(props: DashboardGridProps): JSX.Element {
  return <div class={props.class ? `k2b-dashboard-grid ${props.class}` : "k2b-dashboard-grid"}>{props.children}</div>;
}

export type DashboardSectionProps = {
  /** Visible heading; without it the section has no heading and is named by `ariaLabel`. */
  title?: string;
  /** Tabler icon class shown as a plain glyph before the title, never in a tile. */
  icon?: string;
  /** Colour of the icon glyph; it is mixed with the text colour so it stays readable in light and dark. */
  iconColor?: string;
  /** Source or cadence, quiet and next to the title. */
  description?: string;
  headingLevel?: 2 | 3 | 4;
  ariaLabel?: string;
  class?: string;
  /** Panels and at most one key-figure row (`StatGrid`), in reading order; the row always spans all six columns. */
  children?: JSX.Element;
};

/** A titled group of panels on the six-column grid. */
export function DashboardSection(props: DashboardSectionProps): JSX.Element {
  const id = createUniqueId();
  return (
    <section
      class={props.class ? `k2b-dashboard-section ${props.class}` : "k2b-dashboard-section"}
      aria-labelledby={props.title ? id : undefined}
      aria-label={props.title ? undefined : props.ariaLabel}
    >
      <Show when={props.title}>
        <header class="k2b-dashboard-section__header">
          <Show when={props.icon}>
            <i
              class={`k2b-dashboard-section__icon ${props.icon}`}
              style={props.iconColor ? { color: `color-mix(in srgb, ${props.iconColor} 72%, var(--k2b-text))` } : undefined}
              aria-hidden="true"
            />
          </Show>
          <Dynamic component={`h${props.headingLevel ?? 2}`} id={id} class="k2b-dashboard-section__title">
            {props.title}
          </Dynamic>
          <Show when={props.description}>
            <p class="k2b-dashboard-section__description">{props.description}</p>
          </Show>
        </header>
      </Show>
      <div class="k2b-dashboard-section__grid">{props.children}</div>
    </section>
  );
}

type DashboardPanelTag = "article" | "section" | "div" | "li";

type DashboardPanelOwnProps<T extends DashboardPanelTag> = {
  as?: T;
  /** Defaults to a third. Ignored inside a key-figure row, where every tile takes one of its columns. */
  width?: DashboardWidth;
  class?: string;
  children?: JSX.Element;
};

export type DashboardPanelProps<T extends DashboardPanelTag = "article"> = DashboardPanelOwnProps<T> &
  Omit<JSX.IntrinsicElements[T], keyof DashboardPanelOwnProps<T>>;

const PanelElement = Dynamic as unknown as (props: Record<string, unknown>) => JSX.Element;

/** One framed cell of the grid. Panels in a row share the height of the tallest. */
export function DashboardPanel<T extends DashboardPanelTag = "article">(props: DashboardPanelProps<T>): JSX.Element {
  const [local, element] = splitProps(props, ["as", "width", "class", "children"]);
  return (
    <PanelElement
      component={local.as ?? "article"}
      {...element}
      class={local.class ? `k2b-dashboard-panel ${local.class}` : "k2b-dashboard-panel"}
      data-width={local.width ?? "third"}
    >
      {local.children}
    </PanelElement>
  );
}
