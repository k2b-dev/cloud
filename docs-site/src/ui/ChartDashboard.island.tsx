import { DashboardGrid, DashboardSection, DocCode, SegmentedControl } from "@k2b/ui";
import { createSignal, For } from "solid-js";
import { showcaseDashboard } from "./demo-sections/charts/dashboards";
import { ShowcaseFrame, type ShowcaseState, showcaseStates } from "./demo-sections/charts/ShowcaseFrame";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** Long data lists shortened to their first entries, as the dashboard JSON below the panels shows them. */
const shorten = (value: Json): Json =>
  Array.isArray(value)
    ? value.length > 4
      ? [...value.slice(0, 3).map(shorten), `… ${value.length - 3} more`]
      : value.map(shorten)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shorten(entry)]))
      : value;

/**
 * A panel's content height: its own, or its phone height where the dashboard grid gives every panel the whole row
 * (600 px or less, measured on the grid like its widths). The clamp is a step at that width, without a style hook.
 */
const panelHeight = (height: number, compact = height) =>
  compact === height ? height : `clamp(${compact}px, (100cqw - 600px) * 1000, ${height}px)`;

/** An example dashboard from the catalog mockup, drawn panel by panel from its portable description. */
export default function ChartDashboard(props: { slug: string }) {
  const dashboard = showcaseDashboard(props.slug)!;
  const [state, setState] = createSignal<ShowcaseState>("data");
  const description = () =>
    JSON.stringify(
      shorten({
        title: dashboard.title,
        stats: dashboard.stats,
        sections: dashboard.sections.map((section) => ({
          title: section.title,
          icon: section.icon,
          panels: section.panels.map((panel) => ({ width: panel.width, ...(panel.spec as { [key: string]: Json }) })),
        })),
      } as Json),
      null,
      2,
    );
  return (
    <div class="ui-charts-dashboard k2b-ui">
      <div class="ui-charts-dashboard__bar">
        <div class="ui-charts-dashboard__heading">
          <p>{dashboard.eyebrow}</p>
          <h2>{dashboard.title}</h2>
          <span>{dashboard.asOf}</span>
        </div>
        <div class="ui-charts-control">
          <span>Preview state</span>
          <SegmentedControl ariaLabel="Preview state" size="sm" value={state()} onValueChange={setState} options={showcaseStates} />
        </div>
      </div>
      <DashboardGrid>
        <DashboardSection ariaLabel="Key figures" headingLevel={3}>
          <ShowcaseFrame spec={dashboard.stats} title="Key figures" state={state()} height={0} onRetry={() => setState("data")} />
        </DashboardSection>
        <For each={dashboard.sections}>
          {(section) => (
            <DashboardSection title={section.title} icon={section.icon} headingLevel={3}>
              <For each={section.panels}>
                {(panel) => (
                  <ShowcaseFrame
                    spec={panel.spec}
                    title={panel.id}
                    state={state()}
                    width={panel.width}
                    height={panelHeight(panel.height, panel.compactHeight)}
                    empty={panel.empty}
                    intended={panel.intended}
                    onRetry={() => setState("data")}
                    headingLevel={4}
                  />
                )}
              </For>
            </DashboardSection>
          )}
        </For>
      </DashboardGrid>
      <details class="ui-charts-dashboard__json">
        <summary>Description of this dashboard (JSON, data shortened)</summary>
        <DocCode title="JSON" code={description()} language="js" copy />
      </details>
    </div>
  );
}
