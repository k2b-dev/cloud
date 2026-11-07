import { DocCode, SegmentedControl } from "@k2b/ui";
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
      <ShowcaseFrame spec={dashboard.stats} title="Key figures" state={state()} height={0} onRetry={() => setState("data")} />
      <For each={dashboard.sections}>
        {(section) => (
          <section class="ui-charts-dashboard__section" aria-labelledby={`${section.id}-title`}>
            <h3 class="ui-charts-dashboard__section-title" id={`${section.id}-title`}>
              <i class={section.icon} aria-hidden="true" />
              {section.title}
            </h3>
            <div class="ui-charts-grid">
              <For each={section.panels}>
                {(panel) => (
                  <div
                    class="ui-charts-grid__cell"
                    data-width={panel.width}
                    style={{
                      "--ui-charts-panel": `${panel.height}px`,
                      "--ui-charts-panel-compact": `${panel.compactHeight ?? panel.height}px`,
                    }}
                  >
                    <ShowcaseFrame
                      spec={panel.spec}
                      title={panel.id}
                      state={state()}
                      height="var(--ui-charts-panel-height)"
                      empty={panel.empty}
                      intended={panel.intended}
                      onRetry={() => setState("data")}
                      headingLevel={4}
                    />
                  </div>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
      <details class="ui-charts-dashboard__json">
        <summary>Description of this dashboard (JSON, data shortened)</summary>
        <DocCode title="JSON" code={description()} language="js" copy />
      </details>
    </div>
  );
}
