import type { Message } from "@k2b/nessi";
import { z } from "zod";
import { bindView, blockDataAtPath } from "../blocks/bind";
import { BlockPathSchema, type BoundBlockView } from "../blocks/schema";
import { blocksSummary } from "../blocks/text";
import { validateBlockLink } from "../blocks/validate";

// Read migration only. No producer or live result parser accepts presentation after the contract cut.
const legacyTable = z.strictObject({
  kind: z.literal("table"),
  rowsPath: BlockPathSchema,
  columns: z
    .array(
      z.strictObject({
        path: BlockPathSchema,
        label: z.string().max(500),
        format: z.enum(["text", "number", "date", "datetime"]).optional(),
      }),
    )
    .min(1)
    .max(100),
  rowLinksPath: BlockPathSchema.optional(),
});

export function capabilityResultView(result: unknown): BoundBlockView | null {
  if (!result || typeof result !== "object") return null;
  try {
    const view = blockDataAtPath(result, ["view"]);
    const data = blockDataAtPath(result, ["data"]);
    if (view !== undefined) return bindView(view, data);
    const old = legacyTable.safeParse(blockDataAtPath(result, ["presentation"]));
    if (!old.success) return null;
    const rows = blockDataAtPath(data, old.data.rowsPath);
    if (!Array.isArray(rows)) return null;
    // The old preview showed at most 100 rows. Split wide old tables into 20-column blocks.
    const visible = rows.slice(0, 100).map((row) => {
      const cells: Record<string, unknown> = {};
      old.data.columns.forEach((column, index) => {
        cells[`c${index}`] = blockDataAtPath(row, column.path) ?? null;
      });
      const links = old.data.rowLinksPath ? blockDataAtPath(row, old.data.rowLinksPath) : undefined;
      const href = blockDataAtPath(links, ["0", "href"]);
      if (typeof href === "string") {
        try {
          validateBlockLink(href, "review", { appId: "", appPrefixes: [] });
          cells.href = href;
        } catch {
          /* An invalid old row link never becomes a clickable target. */
        }
      }
      return cells;
    });
    const blocks = [];
    for (let offset = 0; offset < old.data.columns.length; offset += 20) {
      blocks.push({
        kind: "Table",
        title: "Results",
        rows: visible,
        columns: old.data.columns.slice(offset, offset + 20).map((column, index) => ({
          path: [`c${offset + index}`],
          label: column.label.trim().slice(0, 80) || "Value",
          ...(column.format ? { type: column.format } : {}),
        })),
        ...(visible.some((row) => row.href !== undefined) ? { rowHref: ["href"] } : {}),
      });
    }
    return bindView({ version: 1, blocks }, {});
  } catch {
    return null;
  }
}

/** Provider boundary: keep domain data and envelope metadata, send only a short view description. */
export function modelCapabilityResult(result: unknown): unknown {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Object.hasOwn(result, "data") ||
    (!Object.hasOwn(result, "view") && !Object.hasOwn(result, "presentation"))
  )
    return result;
  const view = capabilityResultView(result);
  const rest = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "view" && key !== "presentation"));
  return { ...rest, ...(view ? { viewSummary: blocksSummary(view.blocks) } : {}) };
}

export const modelCapabilityMessage = (message: Message): Message =>
  message.role === "tool_result"
    ? {
        ...message,
        result: modelCapabilityResult(message.result),
        ...(message.historicalResult
          ? { historicalResult: { ...message.historicalResult, value: modelCapabilityResult(message.historicalResult.value) } }
          : {}),
      }
    : message;
