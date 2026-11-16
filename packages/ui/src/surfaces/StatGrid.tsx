import { createContext, type JSX, Show, useContext } from "solid-js";

export type StatGridSize = "lg" | "md" | "sm";
export type StatGridSurface = "white" | "muted";
export type StatGridColumns = 1 | 2 | 3 | 4 | 5 | 6;
export type StatGridAction = { label: string; href: string };
/** `tiles` frames each figure; `plain` sets the figures in equal columns with a thin line between, for a page head. */
export type StatGridVariant = "tiles" | "plain";

export type StatGridProps = {
  children: JSX.Element;
  title?: string;
  action?: StatGridAction;
  /** Tiles per row on a wide container. Defaults to 4; at 600 px or less two share a row, and five or six take three up to 900 px. */
  columns?: StatGridColumns;
  size?: StatGridSize;
  /** Applies to `tiles` only: a `plain` row has no surface. */
  surface?: StatGridSurface;
  /**
   * `tiles` (default) frames each figure. `plain` drops frame, surface and shadow: equal columns with a 1 px line
   * between them, two columns below a 34rem container. Every figure keeps three rows (label, figure, a reserved third
   * line for `sub`, the change or the comparison), so all figures stand on one line.
   */
  variant?: StatGridVariant;
  class?: string;
};

const StatGridSizeContext = createContext<StatGridSize>("md");
// A plain grid has no surface, so the surface context carries "plain" to its cells; a cell outside a grid stays a tile.
const StatGridSurfaceContext = createContext<StatGridSurface | "plain">("white");

export const useStatGridSize = (): StatGridSize => useContext(StatGridSizeContext);
export const useStatGridSurface = (): StatGridSurface | "plain" => useContext(StatGridSurfaceContext);

const columnValue = (columns?: StatGridColumns): StatGridColumns => {
  if (columns && Number.isInteger(columns) && columns >= 1 && columns <= 6) return columns;
  return 4;
};

/**
 * A row of key figures, each a framed tile of its own or, with `variant="plain"`, flat figures in equal columns; the
 * optional title and action sit above the row.
 */
export function StatGrid(props: StatGridProps): JSX.Element {
  const surface = () => props.surface ?? "white";
  const plain = () => props.variant === "plain";
  return (
    <section
      class={`k2b-stat-grid ${props.class ?? ""}`}
      data-columns={columnValue(props.columns)}
      data-size={props.size ?? "md"}
      data-surface={surface()}
      data-variant={plain() ? "plain" : "tiles"}
      aria-label={props.title}
    >
      <Show when={props.title}>
        <header class="k2b-stat-grid__header">
          <span class="k2b-stat-grid__title">{props.title}</span>
          <Show when={props.action}>
            {(action) => (
              <a href={action().href} class="k2b-stat-grid__action">
                <span>{action().label}</span>
                <i class="ti ti-arrow-up-right" aria-hidden="true" />
              </a>
            )}
          </Show>
        </header>
      </Show>
      <StatGridSizeContext.Provider value={props.size ?? "md"}>
        <StatGridSurfaceContext.Provider value={plain() ? "plain" : surface()}>
          <div class="k2b-stat-grid__body">{props.children}</div>
        </StatGridSurfaceContext.Provider>
      </StatGridSizeContext.Provider>
    </section>
  );
}

export default StatGrid;
