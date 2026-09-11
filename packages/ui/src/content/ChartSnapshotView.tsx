import { createEffect, createUniqueId, onCleanup, onMount, type JSX } from "solid-js";
import { isServer } from "solid-js/web";
import { selectedChartSvg } from "./chart-svg";
import { useUiMessages } from "../intl/messages";
import { createChartInspection, sameChartDatum } from "./chart-inspection";
import type { ChartSnapshot } from "./chart-snapshot";

/** Internal display for server-prepared geometry. Viewports are snapshot-owned. */
export function ChartSnapshotView(props: {
  snapshot: ChartSnapshot;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  style?: JSX.CSSProperties;
}) {
  const messages = useUiMessages();
  let container: HTMLDivElement | undefined;
  let tooltip: HTMLSpanElement | undefined;
  let anchor: HTMLSpanElement | undefined;
  const id = `k2b-chart-tooltip-${createUniqueId()}`;
  const inspection = createChartInspection({
    container: () => container,
    tooltip: () => tooltip,
    anchor: () => anchor,
    kind: () => props.snapshot.kind,
    enabled: () => true,
    format: ({ datum }) => props.snapshot.marks.find((m) => sameChartDatum(m.datum, datum))?.tooltip ?? { rows: [] },
    select: ({ datum }) => {
      const mark = props.snapshot.marks.find((m) => sameChartDatum(m.datum, datum));
      if (mark) props.onSelect(mark.key);
    },
  });
  createEffect(() => {
    props.snapshot;
    inspection.invalidate();
  });
  createEffect(() => inspection.selectDatum(props.snapshot.marks.find((m) => m.key === props.selectedKey)?.datum));
  onMount(() => {
    const outside = (event: Event) => {
      if (event.target instanceof Node && !container?.contains(event.target)) inspection.close();
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", inspection.close, true);
    onCleanup(() => {
      window.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", inspection.close, true);
    });
  });
  onCleanup(inspection.close);
  return (
    <div
      ref={container}
      class="k2b-chart"
      data-chart-kind={props.snapshot.kind}
      data-interactive="true"
      style={props.style}
      role="group"
      aria-label={messages().interactiveChart}
      tabIndex={0}
      onPointerDown={inspection.down}
      onPointerMove={inspection.move}
      onClick={inspection.click}
      onPointerLeave={inspection.leave}
      onFocusIn={inspection.focus}
      onFocusOut={inspection.close}
      onKeyDown={inspection.key}
    >
      <div
        class="k2b-chart__svg"
        data-stretch={props.snapshot.stretch ? "true" : undefined}
        style={{
          "--k2b-chart-width": `${props.snapshot.width}px`,
          "--k2b-chart-height": `${props.snapshot.height}px`,
          "aspect-ratio": `${props.snapshot.width}/${props.snapshot.height}`,
        }}
        innerHTML={
          isServer
            ? selectedChartSvg(props.snapshot.svg, props.snapshot.marks.find((m) => m.key === props.selectedKey)?.datum)
            : props.snapshot.svg
        }
      />
      <span ref={anchor} class="k2b-chart__anchor" aria-hidden="true" />
      <span ref={tooltip} id={id} class="k2b-chart__tooltip k2b-tooltip" role="tooltip" popover="manual" data-instant="true" />
    </div>
  );
}
