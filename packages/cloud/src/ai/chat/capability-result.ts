import type { AiTurnBlock } from "../protocol";

/** Result views arrive bound from the server, independent of optional application branding. */
export const capabilityView = (block: Extract<AiTurnBlock, { kind: "tool" }>) =>
  block.status === "completed" && !block.isError ? (block.view ?? null) : null;
export const hasCapabilityView = (block: Extract<AiTurnBlock, { kind: "tool" }>): boolean => capabilityView(block) !== null;
