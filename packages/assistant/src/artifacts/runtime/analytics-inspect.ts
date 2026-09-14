import type { AnalyticsEvent, AnalyticsNode } from "./analytics-contracts";
function interactions(node: AnalyticsNode): Array<{ id: string; event?: AnalyticsEvent }> {
  if (node.disabled) return [];
  const action = (event: AnalyticsEvent) => ({ id: node.id, event });
  switch (node.type) {
    case "button": return [{ id: node.id }];
    case "input": case "number": case "slider": case "dateRange": case "select": case "multiSelect":
      return [action({ type: "change", value: node.value })];
    case "explorer": return [action({ type: "view", value: node.view === "chart" ? "table" : "chart" }), action({ type: "select", key: null })];
    case "table": case "chart": return [action({ type: "select", key: null })];
    case "group": return [action({ type: "refresh" }), action({ type: "request", request: node.desired })];
    default: return [];
  }
}

export function inspectAnalytics(node: AnalyticsNode, offset: number, limit: number, detail: boolean) {
  const base = { type: node.type, label: node.label, description: node.description, disabled: node.disabled, loading: node.loading, interactions: interactions(node) };
  switch (node.type) {
    case "group":
      return {
        ...base,
        desired: node.desired,
        displayed: node.snapshot.request,
        selectedKey: node.selectedKey,
        error: node.error,
        charts: Object.keys(node.snapshot.charts),
        steps: node.steps,
        series: node.series,
      };
    case "explorer":
      return {
        ...base,
        rowKey: node.data.rowKey,
        columns: node.columns,
        context: node.data.context,
        selectedKey: node.selectedKey,
        view: node.view,
        totalRows: node.data.rows.length,
        ...(detail ? { rows: node.data.rows.slice(offset, offset + limit) } : {}),
        chartKind: "kind" in node.data.chart ? node.data.chart.kind : node.data.chart.options.kind,
        ...("kind" in node.data.chart ? {mapping:node.data.chart} : {}),
      };
    case "table":
      return {
        ...base,
        rowKey: node.rowKey,
        columns: node.columns,
        selectedKey: node.selectedKey,
        totalRows: node.rows.length,
        ...(detail ? { rows: node.rows.slice(offset, offset + limit) } : {}),
      };
    case "chart":
      return {
        ...base,
        kind: node.data.options.kind,
        selectedKey: node.selectedKey,
        totalMarks: node.data.marks?.length,
        ...(detail ? { marks: node.data.marks?.slice(offset, offset + limit) } : {}),
      };
    case "select":
    case "multiSelect":
      return {
        ...base,
        value: node.value,
        totalOptions: node.options.length,
        options: node.options.slice(detail ? offset : 0, (detail ? offset : 0) + limit),
      };
    case "layout":
      return { ...base, layout: node.layout, children: node.children };
    case "filePicker":
      return { ...base, names: node.names, multiple: node.multiple, accept: node.accept };
    case "button":
      return base;
    case "stat":
      return {...base,value:node.value,format:node.format,...(detail?{trend:node.trend}:{})};
    default:
      return { ...base, value: node.value };
  }
}
