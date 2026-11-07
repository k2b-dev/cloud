import { Button, useLocale } from "@k2b/ui";
import { chartRenderHeight } from "@k2b/ui/charts/core";
import { type ComponentProps, createMemo, createSignal, createUniqueId, For, Index, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { cloudAiChartRenderOptions } from "../chart-block";
import { parseCloudAiChartToolView } from "../view-block";
import { ChartFrame, type GroupSummary } from "./chart-frame";
import { chartHandoff, drawingKey, drawingSvg } from "./chart-handoff";
import { ExplorerPlaceholder } from "./explorer-placeholder";
import { aiChatMessages } from "./messages";

type Drawing = typeof import("./chart-eager");
let drawing: Drawing | undefined;
let pending: Promise<Drawing | undefined> | undefined;
const load = () =>
  (pending ??= import("./chart-eager").then(
    (module) => (drawing = module),
    () => undefined,
  ));
// Register before the island removes its server children. Each document owns its registry.
chartHandoff();

/** Each chart owns its code wait. The rest of the island mounts immediately. */
function DrawingBoundary(props: {
  name: string;
  input: object;
  fallback: (failed: () => boolean) => JSX.Element;
  children: (module: Drawing) => JSX.Element;
}) {
  const module = useDrawing();
  const locale = useLocale();
  const key = drawingKey(props.name, props.input);
  const retained = chartHandoff()(key);
  const frames = [...(retained?.querySelectorAll<HTMLElement>(".k2b-chart-explorer") ?? [])];
  for (const frame of frames) {
    frame.style.position = "relative";
    // The drawing remains readable by assistive technology; only its inspection and controls wait for code.
    for (const chart of frame.querySelectorAll<HTMLElement>(".k2b-chart")) {
      chart.removeAttribute("tabindex");
      chart.setAttribute("data-interactive", "false");
      chart.setAttribute("aria-disabled", "true");
    }
    for (const control of frame.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")) {
      control.inert = true;
      control.setAttribute("aria-disabled", "true");
      control.style.opacity = "0.4";
      if (
        control instanceof window.HTMLButtonElement ||
        control instanceof window.HTMLInputElement ||
        control instanceof window.HTMLSelectElement ||
        control instanceof window.HTMLTextAreaElement
      )
        control.disabled = true;
    }
  }
  function Upgrade(input: { module: Drawing }) {
    let root!: HTMLDivElement;
    onMount(() => {
      // Keep the actual server SVG node as well as its bytes. The eager host supplies inspection and tooltips.
      const previous = [...(retained?.querySelectorAll(drawingSvg) ?? [])];
      root.querySelectorAll(drawingSvg).forEach((svg, index) => {
        const original = previous[index];
        if (original?.outerHTML === svg.outerHTML) svg.replaceWith(original);
      });
    });
    return (
      <div class="contents" ref={root}>
        {props.children(input.module)}
      </div>
    );
  }
  return (
    <Show
      when={module()}
      fallback={
        <Show when={retained && drawingKey(props.name, props.input) === key} fallback={props.fallback(() => module() === null)}>
          {retained}
          <For each={frames}>
            {(frame) => (
              <Portal
                mount={frame}
                ref={(host) => {
                  host.style.display = "contents";
                }}
              >
                <Show
                  when={module() === null}
                  fallback={
                    <span class="sr-only" role="status" aria-live="polite">
                      {aiChatMessages(locale()).chartLoading}
                    </span>
                  }
                >
                  <div class="absolute inset-x-2 bottom-2 rounded bg-surface p-2 text-sm">
                    <Status failed />
                  </div>
                </Show>
              </Portal>
            )}
          </For>
        </Show>
      }
    >
      {(loaded) => <Upgrade module={loaded()} />}
    </Show>
  );
}

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
function Status(props: { failed: boolean; unavailable?: boolean }) {
  const locale = useLocale();
  return (
    <span role="status" aria-live="polite">
      <span>
        {props.failed
          ? aiChatMessages(locale()).chartLoadFailed
          : props.unavailable
            ? aiChatMessages(locale()).viewUnavailable
            : aiChatMessages(locale()).chartLoading}
      </span>
      <Show when={props.failed}>
        <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
          {aiChatMessages(locale()).chartReload}
        </Button>
      </Show>
    </span>
  );
}
function GroupPlaceholder(props: { summary: GroupSummary; failed: boolean; unavailable?: boolean }) {
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
          {(chart) => (
            <ChartFrame {...chart()} chart={null} nested empty={<Status failed={props.failed} unavailable={props.unavailable} />} />
          )}
        </Index>
      </div>
    </section>
  );
}
export function CloudChartView(props: ComponentProps<Drawing["CloudChartView"]>) {
  return (
    <DrawingBoundary
      name="View"
      input={props}
      fallback={(failed) => (
        <div class="contents" data-cloud-chart-drawing>
          <ChartFrame {...props.summary} chart={null} empty={<Status failed={failed()} unavailable={props.input === null} />} />
        </div>
      )}
    >
      {(loaded) => {
        const Component = loaded.CloudChartView;
        return <Component {...props} />;
      }}
    </DrawingBoundary>
  );
}
export function CloudChartGroupView(props: ComponentProps<Drawing["CloudChartGroupView"]>) {
  return (
    <DrawingBoundary
      name="Group"
      input={props}
      fallback={(failed) => (
        <div class="contents" data-cloud-chart-drawing>
          <GroupPlaceholder summary={props.summary} failed={failed()} unavailable={props.group === null} />
        </div>
      )}
    >
      {(loaded) => {
        const Component = loaded.CloudChartGroupView;
        return <Component {...props} />;
      }}
    </DrawingBoundary>
  );
}
export function CloudExplorerView(props: ComponentProps<Drawing["CloudExplorerView"]>) {
  return (
    <DrawingBoundary
      name="Explorer"
      input={props}
      fallback={(failed) => (
        <div class="contents" data-cloud-chart-drawing>
          <ExplorerPlaceholder summary={props.summary} message={<Status failed={failed()} unavailable={props.input === null} />} />
        </div>
      )}
    >
      {(loaded) => {
        const Component = loaded.CloudExplorerView;
        return <Component {...props} />;
      }}
    </DrawingBoundary>
  );
}
export function CloudChartBlock(props: ComponentProps<Drawing["CloudChartBlock"]>) {
  const locale = useLocale();
  const source = createMemo(() => JSON.stringify(props.args ?? null));
  const view = createMemo(() => parseCloudAiChartToolView(JSON.parse(source())));
  return (
    <DrawingBoundary
      name="Block"
      input={props}
      fallback={(failed) => (
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
                <GroupPlaceholder summary={{ ...value, linkX: value.linkX ?? false, layout: value.layout ?? "stack" }} failed={failed()} />
              ) : (
                <ChartFrame
                  title={value.title}
                  subtitle={value.subtitle}
                  kind={value.kind}
                  chart={null}
                  height={chartRenderHeight(cloudAiChartRenderOptions(value, locale(), { legend: "outside" }))}
                  empty={<Status failed={failed()} />}
                />
              );
            }}
          </Show>
        </div>
      )}
    >
      {(loaded) => {
        const Component = loaded.CloudChartBlock;
        return <Component {...props} />;
      }}
    </DrawingBoundary>
  );
}
