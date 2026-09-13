import type { AnalyticsNode } from "./analytics-contracts";
export function inspectAnalytics(node: AnalyticsNode, offset: number, limit: number, detail: boolean) {
  const base = { type: node.type, label: node.label, description: node.description, disabled: node.disabled, loading: node.loading };
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
        rows: detail ? node.data.rows.slice(offset, offset + limit) : [],
        chartKind: "kind" in node.data.chart ? node.data.chart.kind : node.data.chart.options.kind,
      };
    case "table":
      return {
        ...base,
        rowKey: node.rowKey,
        columns: node.columns,
        selectedKey: node.selectedKey,
        totalRows: node.rows.length,
        rows: detail ? node.rows.slice(offset, offset + limit) : [],
      };
    case "chart":
      return {
        ...base,
        kind: node.data.options.kind,
        selectedKey: node.selectedKey,
        totalMarks: node.data.marks?.length,
        marks: detail ? node.data.marks?.slice(offset, offset + limit) : [],
      };
    case "select":
    case "multiSelect":
      return {
        ...base,
        value: node.value,
        totalOptions: node.options.length,
        options: detail ? node.options.slice(offset, offset + limit) : [],
      };
    case "layout":
      return { ...base, layout: node.layout, children: node.children };
    case "filePicker":
      return { ...base, names: node.names, multiple: node.multiple, accept: node.accept };
    case "button":
      return base;
    default:
      return { ...base, value: node.value };
  }
}
