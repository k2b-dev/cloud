import { CloudAiCardInputSchema, cloudAiChartTable, parseCloudAiChartInput } from "@k2b/cloud/ai/browser";
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

/** Prints what a completed card or chart call shows in the web chat; false for every other tool. */
export const printDeliveredBlock = (ctx: CloudCliContext, block: { name: string; args?: unknown }): boolean => {
  if (block.name === "card") return printCard(ctx, block.args);
  if (block.name === "chart") return printChart(ctx, block.args);
  return false;
};
