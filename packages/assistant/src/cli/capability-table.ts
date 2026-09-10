import type { CloudCliContext } from "@k2b/cloud/cli";
import { CapabilitySemanticLinkSchema, CapabilityTablePresentationSchema, capabilityDataAtPath } from "@k2b/cloud/contracts";
import { terminalSafeText } from "./terminal";

const cellText = (value: unknown): string => {
  const text = terminalSafeText(value == null ? "—" : typeof value === "string" ? value : (JSON.stringify(value) ?? "—")).replaceAll(
    /\s+/g,
    " ",
  );
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

/** Presentation only: keep the original result and machine output intact. */
export const printCapabilityTable = (ctx: CloudCliContext, result: unknown): boolean => {
  const parsed = CapabilityTablePresentationSchema.safeParse(capabilityDataAtPath(result, ["presentation"]));
  if (!parsed.success) return false;
  const rows = capabilityDataAtPath(capabilityDataAtPath(result, ["data"]), parsed.data.rowsPath);
  if (!Array.isArray(rows)) return false;
  ctx.print();
  const summary = capabilityDataAtPath(result, ["summary"]);
  if (typeof summary === "string") ctx.print(terminalSafeText(summary).replaceAll(/\s+/g, " "));
  ctx.table(
    rows
      .slice(0, 100)
      .map((row) =>
        Object.fromEntries(parsed.data.columns.map((column, index) => [String(index), cellText(capabilityDataAtPath(row, column.path))])),
      ),
    parsed.data.columns.map((column, index) => ({ key: String(index), label: cellText(column.label) })),
  );
  if (rows.length === 0) ctx.print("No rows.");
  if (rows.length > 100) ctx.print(`Showing 100 of ${rows.length} returned rows.`);
  if (capabilityDataAtPath(result, ["page", "hasMore"]) === true) ctx.print("More results are available on the next page.");
  const links = capabilityDataAtPath(result, ["links"]);
  if (Array.isArray(links)) {
    for (const value of links) {
      const link = CapabilitySemanticLinkSchema.safeParse(value);
      if (!link.success) continue;
      const href = ctx.options.server ? new URL(link.data.href, ctx.options.server).href : link.data.href;
      ctx.print(`${cellText(link.data.title ?? link.data.rel)}: ${terminalSafeText(href)}`);
    }
  }
  ctx.print();
  return true;
};
