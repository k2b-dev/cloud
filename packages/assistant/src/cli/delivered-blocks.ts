import {
  CLOUD_AI_VIEW_MAX_BYTES,
  CloudAiCardInputSchema,
  type CloudAiChartView,
  type CloudAiGroupView,
  CloudAiViewSummarySchema,
  type CloudAiViewTable,
  cloudAiChartTable,
  cloudAiDetailsRows,
  cloudAiExplorerControls,
  cloudAiExplorerState,
  cloudAiStatsTiles,
  cloudAiViewTable,
  isAiViewFile,
  parseCloudAiChartToolView,
  parseCloudAiView,
} from "@k2b/cloud/ai/browser";
import type { CloudCliContext } from "@k2b/cloud/cli";
import { terminalSafeText } from "./terminal";

const printCard = (ctx: CloudCliContext, args: unknown): boolean => {
  const card = CloudAiCardInputSchema.safeParse(args);
  if (!card.success) return false;
  ctx.print(terminalSafeText(`${card.data.title}: ${card.data.value}`));
  if (card.data.caption) ctx.print(terminalSafeText(card.data.caption));
  return true;
};

const printTable = (ctx: CloudCliContext, table: CloudAiViewTable, presented: boolean) => {
  ctx.table(
    [...table.rows.slice(0, 100), ...(table.footer ? [table.footer] : [])].map((row) =>
      Object.fromEntries(table.columns.map((column) => [column.id, terminalSafeText(row.cells[column.id] ?? "")])),
    ),
    table.columns.map((column) => ({ key: column.id, label: terminalSafeText(column.label) })),
  );
  if (table.rows.length > 100)
    ctx.print(
      presented
        ? `Showing 100 of ${table.rows.length} rows; Copy data in the web chat copies all of them.`
        : `Showing 100 of ${table.rows.length} values; the web chat shows all of them.`,
    );
};
const printChartView = (ctx: CloudCliContext, view: CloudAiChartView | CloudAiGroupView, presented = false) => {
  ctx.print();
  ctx.print(terminalSafeText(view.title));
  if (view.subtitle) ctx.print(terminalSafeText(view.subtitle));
  if (view.view === "group") {
    for (const chart of view.charts) {
      ctx.print(terminalSafeText(chart.title));
      if (chart.subtitle) ctx.print(terminalSafeText(chart.subtitle));
      printTable(ctx, cloudAiChartTable(chart, ctx.options.locale ?? "en"), presented);
    }
  } else printTable(ctx, cloudAiChartTable(view, ctx.options.locale ?? "en"), presented);
  ctx.print();
};

/** A terminal prints each chart's data table, the same rows the web table shows. */
const printChart = (ctx: CloudCliContext, args: unknown): boolean => {
  const view = parseCloudAiChartToolView(args);
  if (!view) return false;
  printChartView(ctx, view);
  return true;
};

/** Prints a completed card, chart or presented view as the web chat shows it. */
export const printDeliveredBlock = async (
  ctx: CloudCliContext,
  block: { name: string; args?: unknown; result?: unknown },
  conversationId: string,
  signal: AbortSignal,
): Promise<boolean> => {
  if (block.name === "present") return printView(ctx, block.result, conversationId, signal);
  if (block.name === "card") return printCard(ctx, block.args);
  if (block.name === "chart") return printChart(ctx, block.args);
  return false;
};

async function printView(ctx: CloudCliContext, result: unknown, conversationId: string, signal: AbortSignal): Promise<boolean> {
  if (!result || typeof result !== "object" || !("view" in result) || !("path" in result) || typeof result.path !== "string") return false;
  const path = result.path;
  try {
    const summary = CloudAiViewSummarySchema.safeParse(result.view);
    if (!summary.success || !isAiViewFile({ path, origin: "assistant" })) throw new Error("Invalid view reference");
    const response = await ctx.fetch(
      `/api/ai/conversations/${encodeURIComponent(conversationId)}/files/content?${new URLSearchParams({ path })}`,
      { signal },
    );
    if (!response.ok || !isAiViewFile({ path, origin: response.headers.get("X-Cloud-Ai-File-Origin") ?? "" }))
      throw new Error("Missing view");
    const blob = await response.blob();
    if (blob.size > CLOUD_AI_VIEW_MAX_BYTES) throw new Error("Oversized view");
    const view = parseCloudAiView(JSON.parse(await blob.text()));
    if (
      !view ||
      view.view !== summary.data.view ||
      (view.view === "chart" && summary.data.view === "chart" && view.kind !== summary.data.kind)
    )
      throw new Error("Invalid view");
    if (view.view === "chart" || view.view === "group") printChartView(ctx, view, true);
    else {
      ctx.print();
      ctx.print(terminalSafeText(view.title));
      if (view.subtitle) ctx.print(terminalSafeText(view.subtitle));
      const locale = ctx.options.locale ?? "en";
      if (view.view === "stats" || view.view === "details") {
        const rows =
          view.view === "stats"
            ? cloudAiStatsTiles(view, locale).map((tile) => ({
                label: tile.label,
                value: `${tile.value}${tile.delta ? ` (${tile.delta.text})` : ""}${tile.sub ? ` · ${tile.sub}` : ""}`,
              }))
            : cloudAiDetailsRows(view, locale).map((row) => ({
                label: row.label,
                value: row.ref ? `${row.text} (${row.ref.type}:${row.ref.id})` : row.text,
              }));
        ctx.table(
          rows.map((row) => ({ label: terminalSafeText(row.label), value: terminalSafeText(row.value) })),
          [
            { key: "label", label: "Field" },
            { key: "value", label: "Value" },
          ],
        );
      } else {
        const table = cloudAiViewTable(view, locale);
        // An explorer prints the rows of its initial state, as the chat first shows it.
        if (view.view === "explorer") {
          const rows = new Set(cloudAiExplorerState(view, cloudAiExplorerControls(view, locale).initial, locale).rows);
          table.rows = table.rows.filter((row) => rows.has(Number(row.key)));
        }
        for (const row of [...table.rows, ...(table.footer ? [table.footer] : [])]) {
          const cells = row.key === "footer" ? ("footer" in view ? view.footer : undefined) : view.rows[Number(row.key)];
          for (const column of view.columns) {
            const ref = cells && Object.hasOwn(cells, column.id) ? cells[column.id] : undefined;
            if (column.type === "ref" && ref && typeof ref === "object")
              row.cells[column.id] = `${ref.title ?? ref.id} (${ref.type}:${ref.id})`;
          }
        }
        printTable(ctx, table, true);
      }
      ctx.print();
    }
  } catch {
    ctx.print(`View unavailable: ${terminalSafeText(path)}`);
  }
  return true;
}
