import { artifactMessages } from "./messages";
import type { AnalyticsNode } from "./runtime/analytics-contracts";
import { formatValue } from "./runtime/analytics-contracts";
import { chartSnapshot, explorerChart } from "./analytics-chart";
import { validateTree } from "./runtime/host";

const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!);
export function presentationChartSvg(node: AnalyticsNode, locale: string) {
  if (node.type === "chart") return chartSnapshot(node.data, locale).svg;
  if (node.type === "explorer") return explorerChart(node.data, node.columns, locale).chart.svg;
  throw new Error("Select a chart to export SVG");
}
/** Render data, never capture live controls or trust HTML supplied by a program. */
export function presentationHtml(nodes: AnalyticsNode[], title: string, locale: string) {
  validateTree(nodes);
  if (nodes.some(node => node.loading || (node.type === "group" && node.error))) throw new Error(artifactMessages.resolve([locale]).t.visualizationWait);
  const by = new Map(nodes.map(node => [node.id, node]));
  const children = new Set(nodes.flatMap(node => node.type === "layout" ? node.children : []));
  function render(node: AnalyticsNode): string {
    const heading = node.label ? `<h2>${escape(node.label)}</h2>` : "";
    const description = node.description ? `<p>${escape(node.description)}</p>` : "";
    let body = "";
    switch (node.type) {
      case "button": return "";
      case "layout": body = `<div class="${node.layout === "grid" || node.layout === "row" ? "grid" : "column"}">${node.children.map(id => render(by.get(id)!)).join("")}</div>`; break;
      case "text": body = `<p class="text">${escape(node.value)}</p>`; break;
      case "stat": body = `<p class="stat">${escape(formatValue(node.value, node.format, locale))}</p>`; break;
      case "chart": body = presentationChartSvg(node, locale); break;
      case "table":
      case "explorer": {
        const rows = node.type === "table" ? node.rows : node.data.rows;
        if (node.type === "explorer") {
          const context = node.data.context;
          if (context) body += `<p>${escape(context.mode)} · ${escape(context.asOf)} · ${escape(context.status)}<br>${context.sources.map(source => escape(source.label)).join(" · ")}<br>${escape(context.note)}</p>`;
          if (node.view === "chart") body += presentationChartSvg(node, locale);
        }
        if (node.type === "table" || node.view === "table") body += `<table><thead><tr>${node.columns.map(column => `<th>${escape(column.label)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${node.columns.map(column => `<td>${escape(formatValue(row[column.key] ?? null, column.format, locale))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
        break;
      }
      case "select": body = `<p>${escape(node.options.find(option => option.value === node.value)?.label ?? node.value)}</p>`; break;
      case "multiSelect": body = `<p>${node.value.map(value => escape(node.options.find(option => option.value === value)?.label ?? value)).join(", ")}</p>`; break;
      case "dateRange": body = `<p>${escape(node.value.start)} – ${escape(node.value.end)}</p>`; break;
      case "filePicker": body = `<p>${escape(node.names)}</p>`; break;
      case "group": {
        const request = node.snapshot.request;
        const step = (key: string | undefined) => key ? node.steps?.find(item => item.key === key)?.label ?? key : "";
        body = `<p>${escape(step(request.step))}${request.referenceStep ? ` / ${escape(step(request.referenceStep))}` : ""}${request.visibleKeys ? ` · ${request.visibleKeys.map(key => escape(node.series?.find(item => item.key === key)?.label ?? key)).join(", ")}` : ""}</p>`;
        break;
      }
      case "input": case "number": case "slider": body = `<p>${escape(node.value)}</p>`; break;
      default: { const unsupported: never = node; throw new Error(`Unsupported export node: ${unsupported}`); }
    }
    return `<section>${heading}${description}${body}</section>`;
  }
  return `<!doctype html><html lang="${escape(locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>
:root{color-scheme:light;font-family:system-ui,sans-serif;color:#20242a;background:white;--k2b-text:#20242a;--k2b-text-muted:#626975;--k2b-border:#d8dde5;--k2b-surface:white}body{margin:24px;line-height:1.5}h1{font-size:24px}h2{font-size:17px;margin:0 0 8px}p{margin:8px 0}section{min-width:0;margin-bottom:20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:20px}.stat{font-size:28px;font-weight:600}.text{white-space:pre-wrap}svg{width:100%;height:auto;max-height:420px}table{width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed}th,td{text-align:left;padding:7px;border-bottom:1px solid #ddd;overflow-wrap:anywhere}thead{display:table-header-group}tr,svg,.stat{break-inside:avoid}h1,h2{break-after:avoid}@page{size:A4;margin:16mm}@media print{body{margin:0}.grid{display:block}section{overflow:visible}}
</style></head><body><h1>${escape(title)}</h1>${nodes.filter(node => !children.has(node.id)).map(render).join("")}</body></html>`;
}
