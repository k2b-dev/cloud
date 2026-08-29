import type { DataTableColumn } from "@k2b/ui";
import type { PulseCurrentState, PulseMetricSeries, PulseMetricSummary, PulseRecordedEvent } from "../../contracts";
import type { ActivityEventGroup, ActivityStateGroup } from "./types";
import type { pulseMessages } from "../../messages";

type Messages = ReturnType<typeof pulseMessages.resolve>["t"];

export const eventColumns = (t: Messages): DataTableColumn<PulseRecordedEvent>[] => [
  { id: "kind", header: t.event, value: "kind", cellClass: "min-w-52" },
  { id: "subject", header: t.subject, cellClass: "min-w-56" },
  { id: "source", header: t.source, cellClass: "w-40 whitespace-nowrap" },
  { id: "dimensions", header: t.dimensions, cellClass: "min-w-56" },
  { id: "value", header: t.value, cellClass: "w-24 whitespace-nowrap" },
  { id: "time", header: t.time, cellClass: "w-44 whitespace-nowrap" },
];

export const eventGroupColumns = (t: Messages): DataTableColumn<ActivityEventGroup>[] => [
  { id: "kind", header: t.event, value: "kind", cellClass: "min-w-52" },
  { id: "subject", header: t.subject, value: "subject", cellClass: "min-w-56" },
  { id: "source", header: t.source, cellClass: "w-40 whitespace-nowrap" },
  { id: "value", header: t.latestValue, cellClass: "min-w-32 whitespace-nowrap" },
  { id: "count", header: t.rows, cellClass: "w-20 whitespace-nowrap" },
  { id: "time", header: t.latest, cellClass: "w-44 whitespace-nowrap" },
];

export const stateColumns = (t: Messages): DataTableColumn<PulseCurrentState>[] => [
  { id: "key", header: t.state, value: "key", cellClass: "min-w-52" },
  { id: "value", header: t.value, cellClass: "min-w-40" },
  { id: "subject", header: t.subject, cellClass: "min-w-56" },
  { id: "source", header: t.source, cellClass: "w-40 whitespace-nowrap" },
  { id: "dimensions", header: t.dimensions, cellClass: "min-w-56" },
  { id: "updated", header: t.updated, cellClass: "w-44 whitespace-nowrap" },
];

export const stateGroupColumns = (t: Messages): DataTableColumn<ActivityStateGroup>[] => [
  { id: "key", header: t.state, value: "key", cellClass: "min-w-52" },
  { id: "source", header: t.source, cellClass: "w-40 whitespace-nowrap" },
  { id: "value", header: t.latestValue, cellClass: "min-w-40" },
  { id: "updated", header: t.latest, cellClass: "w-44 whitespace-nowrap" },
];

export const metricColumns = (t: Messages): DataTableColumn<PulseMetricSummary>[] => [
  { id: "name", header: t.metric, value: "name", cellClass: "min-w-72" },
  { id: "type", header: t.type, value: "type", cellClass: "w-24 whitespace-nowrap" },
  { id: "unit", header: t.unit, cellClass: "w-24 whitespace-nowrap" },
  { id: "sources", header: t.sources, cellClass: "w-24 whitespace-nowrap" },
  { id: "resources", header: t.resources, cellClass: "w-28 whitespace-nowrap" },
  { id: "series", header: t.variantsLabel, cellClass: "w-24 whitespace-nowrap" },
  { id: "lastSeen", header: t.lastSeen, cellClass: "w-44 whitespace-nowrap" },
];

export const metricSeriesColumns = (t: Messages): DataTableColumn<PulseMetricSeries>[] => [
  { id: "subject", header: t.subject, cellClass: "min-w-56" },
  { id: "current", header: t.current, cellClass: "w-32 whitespace-nowrap" },
  { id: "source", header: t.source, cellClass: "w-40 whitespace-nowrap" },
  { id: "dimensions", header: t.dimensions, cellClass: "min-w-56" },
  { id: "lastSeen", header: t.lastSeen, cellClass: "w-44 whitespace-nowrap" },
];
