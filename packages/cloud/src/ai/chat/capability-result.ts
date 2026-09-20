import { CapabilityTablePresentationSchema, capabilityDataAtPath } from "../../contracts/capabilities";
import type { AiTurnBlock } from "../protocol";

export const capabilityTable = (result: unknown) => {
  if (!result || typeof result !== "object") return null;
  const presentation = CapabilityTablePresentationSchema.safeParse(capabilityDataAtPath(result, ["presentation"]));
  if (!presentation.success) return null;
  const rows = capabilityDataAtPath(capabilityDataAtPath(result, ["data"]), presentation.data.rowsPath);
  if (!Array.isArray(rows)) return null;
  return { presentation: presentation.data, rows };
};

/** Result presentation is independent of optional app branding. */
export const hasCapabilityTable = (block: Extract<AiTurnBlock, { kind: "tool" }>): boolean =>
  block.status === "completed" && !block.isError && capabilityTable(block.result) !== null;
