import { useLocale } from "@k2b/ui";
import { chartRenderHeight } from "@k2b/ui/charts/core";
import { type ComponentProps, createMemo, createSignal, createUniqueId, Index, onCleanup, onMount, Show } from "solid-js";
import { importOnDemand } from "../../browser/reload";
import { cloudAiChartRenderOptions } from "../chart-block";
import { parseCloudAiChartToolView } from "../view-block";
import { ChartFrame, type GroupSummary } from "./chart-frame";
import { ExplorerPlaceholder } from "./explorer-placeholder";
import { aiChatMessages } from "./messages";

type Drawing = typeof import("./chart-eager");
let drawing: Drawing | undefined;
let pending: Promise<Drawing | undefined> | undefined;
const load = () => (pending ??= importOnDemand(() => import("./chart-eager")).then((module) => (drawing = module)));

// SSR islands re-render rather than hydrate. Wait before their HTML is cleared when it already contains a drawing.
// This also runs for a server page inserted by progressive navigation. A failed load retains the SVG and offers Reload.
window.addEventListener("ssr:before-island-mount", (event) => {
  if (!(event.target instanceof HTMLElement) || !event.target.querySelector("[data-cloud-chart-drawing] svg") || drawing) return;
  event.preventDefault();
  void load().then((module) => {
    if (module) event.detail.resume();
  });
});

function useDrawing() {
  const [module, setModule] = createSignal<Drawing | null | undefined>(drawing);
  onMount(() => {
    let disposed = false;
    onCleanup(() => {
      disposed = true;
    });
    if (!module())
      void load().then((loaded) => {
        if (!disposed) setModule(loaded ?? null);
      });
  });
  return module;
}
function Status(props: { failed: boolean }) {
  const locale = useLocale();
  return <span role="status">{props.failed ? aiChatMessages(locale()).viewUnavailable : aiChatMessages(locale()).viewLoading}</span>;
}
function GroupPlaceholder(props: { summary: GroupSummary; failed: boolean }) {
  const id = `cloud-chart-group-${createUniqueId()}`;
  return (
    <section class="@container grid min-w-0 gap-3" aria-labelledby={id}>
      <header class="min-w-0">
        <h3 id={id} class="m-0 text-base font-semibold">
          {props.summary.title}
        </h3>
        <Show when={props.summary.subtitle}>{(subtitle) => <span class="text-sm text-secondary">{subtitle()}</span>}</Show>
      </header>
      <div class={`grid min-w-0 gap-6 ${props.summary.layout === "grid" ? "@2xl:grid-cols-2" : ""}`}>
        <Index each={props.summary.charts}>
          {(chart) => <ChartFrame {...chart()} chart={null} nested empty={<Status failed={props.failed} />} />}
        </Index>
      </div>
    </section>
  );
}
export function CloudChartView(props: ComponentProps<Drawing["CloudChartView"]>) {
  const module = useDrawing();
  return (
    <Show
      when={module()}
      fallback={
        <div class="contents" data-cloud-chart-drawing>
          <ChartFrame {...props.summary} chart={null} empty={<Status failed={module() === null || props.input === null} />} />
        </div>
      }
    >
      {(loaded) => {
        const Component = loaded().CloudChartView;
        return <Component {...props} />;
      }}
    </Show>
  );
}
export function CloudChartGroupView(props: ComponentProps<Drawing["CloudChartGroupView"]>) {
  const module = useDrawing();
  return (
    <Show
      when={module()}
      fallback={
        <div class="contents" data-cloud-chart-drawing>
          <GroupPlaceholder summary={props.summary} failed={module() === null || props.group === null} />
        </div>
      }
    >
      {(loaded) => {
        const Component = loaded().CloudChartGroupView;
        return <Component {...props} />;
      }}
    </Show>
  );
}
export function CloudExplorerView(props: ComponentProps<Drawing["CloudExplorerView"]>) {
  const module = useDrawing();
  return (
    <Show
      when={module()}
      fallback={
        <div class="contents" data-cloud-chart-drawing>
          <ExplorerPlaceholder summary={props.summary} message={<Status failed={module() === null || props.input === null} />} />
        </div>
      }
    >
      {(loaded) => {
        const Component = loaded().CloudExplorerView;
        return <Component {...props} />;
      }}
    </Show>
  );
}
export function CloudChartBlock(props: ComponentProps<Drawing["CloudChartBlock"]>) {
  const module = useDrawing();
  const locale = useLocale();
  const source = createMemo(() => JSON.stringify(props.args ?? null));
  const view = createMemo(() => parseCloudAiChartToolView(JSON.parse(source())));
  return (
    <Show
      when={module()}
      fallback={
        <div class="contents" data-cloud-chart-drawing>
          <Show
            when={view()}
            fallback={
              <Show when={props.completed}>
                <p class="text-sm text-secondary">{aiChatMessages(locale()).chartUnavailable}</p>
              </Show>
            }
          >
            {(input) => {
              const value = input();
              return value.view === "group" ? (
                <GroupPlaceholder
                  summary={{ ...value, linkX: value.linkX ?? false, layout: value.layout ?? "stack" }}
                  failed={module() === null}
                />
              ) : (
                <ChartFrame
                  title={value.title}
                  subtitle={value.subtitle}
                  kind={value.kind}
                  chart={null}
                  height={chartRenderHeight(cloudAiChartRenderOptions(value, locale(), { legend: "outside" }))}
                  empty={<Status failed={module() === null} />}
                />
              );
            }}
          </Show>
        </div>
      }
    >
      {(loaded) => {
        const Component = loaded().CloudChartBlock;
        return <Component {...props} />;
      }}
    </Show>
  );
}
