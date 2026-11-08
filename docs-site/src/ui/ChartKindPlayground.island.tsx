import { DocCode, SegmentedControl, SelectChip } from "@k2b/ui";
import { createSignal, For, Show } from "solid-js";
import { chartShowcaseKind } from "./demo-sections/charts/examples";
import { ShowcaseFrame, type ShowcaseState, showcaseStates } from "./demo-sections/charts/ShowcaseFrame";
import { specToTsx } from "./demo-sections/charts/tsx";

/** The live example of one kind with switches for its state, its view and its width, and the same description as code. */
export default function ChartKindPlayground(props: { kind: string }) {
  const kind = chartShowcaseKind(props.kind)!;
  const [exampleId, setExampleId] = createSignal(kind.examples[0]!.id);
  const [state, setState] = createSignal<ShowcaseState>("data");
  const [view, setView] = createSignal<"chart" | "table">("chart");
  const [width, setWidth] = createSignal<"wide" | "phone">("wide");
  const [code, setCode] = createSignal<"tsx" | "json">("tsx");
  const example = () => kind.examples.find((entry) => entry.id === exampleId()) ?? kind.examples[0]!;
  return (
    <div class="ui-charts-playground k2b-ui">
      <div class="ui-charts-controls" role="group" aria-label="Example controls">
        <Show when={kind.examples.length > 1}>
          <div class="ui-charts-control">
            <span>Example</span>
            {/* A few examples read as segments; more of them as one menu, which never crowds a phone. */}
            <Show
              when={kind.examples.length <= 3}
              fallback={
                <SelectChip<string>
                  stableWidth
                  aria-label="Example"
                  value={exampleId()}
                  onValueChange={setExampleId}
                  options={kind.examples.map((entry) => ({ value: entry.id, label: entry.title }))}
                />
              }
            >
              <SegmentedControl
                ariaLabel="Example"
                size="sm"
                value={exampleId()}
                onValueChange={setExampleId}
                options={kind.examples.map((entry) => ({ value: entry.id, label: entry.title }))}
              />
            </Show>
          </div>
        </Show>
        <div class="ui-charts-control">
          <span>State</span>
          <SegmentedControl ariaLabel="State" size="sm" value={state()} onValueChange={setState} options={showcaseStates} />
        </div>
        <div class="ui-charts-control">
          <span>View</span>
          <SegmentedControl
            ariaLabel="View"
            size="sm"
            value={view()}
            onValueChange={setView}
            options={[
              { value: "chart", label: "Chart", icon: "ti ti-chart-bar" },
              { value: "table", label: "Table", icon: "ti ti-table" },
            ]}
          />
        </div>
        <div class="ui-charts-control" data-control="width">
          <span>Width</span>
          <SegmentedControl
            ariaLabel="Width"
            size="sm"
            value={width()}
            onValueChange={setWidth}
            options={[
              { value: "wide", label: "Wide", icon: "ti ti-device-desktop" },
              { value: "phone", label: "Phone", icon: "ti ti-device-mobile" },
            ]}
          />
        </div>
      </div>
      <div class="ui-charts-stage" data-width={width()}>
        <For each={[example()]}>
          {(current) => (
            <ShowcaseFrame
              spec={current.spec}
              title={current.title}
              subtitle={current.summary}
              state={state()}
              height={current.height ?? 260}
              view={view()}
              onViewChange={setView}
              onRetry={() => setState("data")}
              headingLevel={2}
            />
          )}
        </For>
        <Show when={kind.examples.length > 1}>
          <p class="ui-charts-stage__note">{example().summary}</p>
        </Show>
      </div>
      <div class="ui-charts-code">
        <div class="ui-charts-code__head">
          <h2>The same description</h2>
          <SegmentedControl
            ariaLabel="Code"
            size="sm"
            value={code()}
            onValueChange={setCode}
            options={[
              { value: "tsx", label: "TSX" },
              { value: "json", label: "JSON" },
            ]}
          />
        </div>
        <p>
          {code() === "json"
            ? "The portable form that Pulse saves, Chat and Code pages send and Notebooks embed. The page draws the example above from exactly this."
            : (example().spec as { block?: unknown }).block === "stats"
              ? "The same description as props of the key figure tiles, with every number formatted for the reader."
              : "The same description as props of the typed chart component. Callbacks such as tooltip or onSelect are props only and never part of the JSON. Where the JSON names a format or a date, pass a format function and numeric x values until the chart component reads the portable description itself."}
        </p>
        <Show when={code() === "tsx"} fallback={<DocCode title="JSON" code={JSON.stringify(example().spec, null, 2)} language="js" copy />}>
          <DocCode title="TSX" code={specToTsx(example().spec)} language="tsx" copy />
        </Show>
      </div>
    </div>
  );
}
