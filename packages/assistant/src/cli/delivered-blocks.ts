import {
  CLOUD_AI_VIEW_MAX_BYTES,
  CloudAiCardInputSchema,
  CloudAiViewSummarySchema,
  type CloudAiViewTable,
  cloudAiChartTable,
  cloudAiViewTable,
  isAiViewFile,
  parseCloudAiChartInput,
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

/** A terminal cannot draw the chart; it prints the chart's data table, the same rows the web table shows. */
const printChart = (ctx: CloudCliContext, args: unknown): boolean => {
  const chart = parseCloudAiChartInput(args);
  if (!chart) return false;
  const table = cloudAiChartTable(chart, ctx.options.locale ?? "en");
  ctx.print();
  ctx.print(terminalSafeText(chart.title));
  if (chart.subtitle) ctx.print(terminalSafeText(chart.subtitle));
  ctx.table(
    table.rows
      .slice(0, 100)
      .map((row) => Object.fromEntries(table.columns.map((column) => [column.id, terminalSafeText(row.cells[column.id] ?? "")]))),
    table.columns.map((column) => ({ key: column.id, label: column.label })),
  );
  if (table.rows.length > 100) ctx.print(`Showing 100 of ${table.rows.length} values; the web chat shows all of them.`);
  ctx.print();
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
    const table: CloudAiViewTable =
      view.view === "chart" ? cloudAiChartTable(view, ctx.options.locale ?? "en") : cloudAiViewTable(view, ctx.options.locale ?? "en");
    const footer = table.footer ? [table.footer] : [];
    ctx.print();
    ctx.print(terminalSafeText(view.title));
    if (view.subtitle) ctx.print(terminalSafeText(view.subtitle));
    ctx.table(
      [...table.rows.slice(0, 100), ...footer].map((row) =>
        Object.fromEntries(table.columns.map((column) => [column.id, terminalSafeText(row.cells[column.id] ?? "")])),
      ),
      table.columns.map((column) => ({ key: column.id, label: terminalSafeText(column.label) })),
    );
    if (table.rows.length > 100) ctx.print(`Showing 100 of ${table.rows.length} rows; Copy data in the web chat copies all of them.`);
    ctx.print();
  } catch {
    ctx.print(`View unavailable: ${terminalSafeText(path)}`);
  }
  return true;
}
