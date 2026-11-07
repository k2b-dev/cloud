import { createEffect, onCleanup, onMount } from "solid-js";
import type { ChartCursor } from "./chart-cursor";
import {
  type ChartKind,
  type ChartSelection,
  type ChartTooltipFormatter,
  createChartInspector,
  mountCalendarScroll,
} from "./chart-inspection-core";

export type { ChartSelection } from "./chart-inspection-core";

export function createChartInspection(options: {
  container: () => HTMLDivElement | undefined;
  cursor?: () => ChartCursor | undefined;
  tooltip: () => HTMLSpanElement | undefined;
  anchor: () => HTMLSpanElement | undefined;
  kind: () => ChartKind;
  enabled: () => boolean;
  format: ChartTooltipFormatter;
  select: (selection: ChartSelection) => void;
}) {
  const inspector = createChartInspector(options);
  createEffect(() => {
    const cursor = options.cursor?.();
    onCleanup(inspector.linkCursor(cursor));
  });
  onMount(() => {
    const container = options.container();
    if (container) onCleanup(mountCalendarScroll(container));
  });
  onCleanup(inspector.destroy);
  const { linkCursor, destroy, ...inspection } = inspector;
  return inspection;
}
