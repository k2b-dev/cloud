import type { AiTurnBlock, AiWireEvent } from "./protocol";

/** Execution keeps the module; chat details, history and pending-action reads carry only its other arguments. */
export function publicAiToolInput(name: string, args: Record<string, unknown>): Record<string, unknown>;
export function publicAiToolInput(name: string, args: unknown): unknown;
export function publicAiToolInput(name: string, args: unknown): unknown {
  if (name !== "code_run" || args === null || typeof args !== "object" || Array.isArray(args)) return args;
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== "code"));
}

export const publicAiToolBlock = (block: AiTurnBlock): AiTurnBlock =>
  block.kind === "tool" ? { ...block, args: publicAiToolInput(block.name, block.args) } : block;

/** Covers live steps and a resumed turn's baseline, including events saved by an earlier worker. */
export const publicAiToolEvent = (event: AiWireEvent): AiWireEvent => {
  if (event.type === "block_set") return { ...event, block: publicAiToolBlock(event.block) };
  if (event.type === "turn_started" && event.blocks) return { ...event, blocks: event.blocks.map(publicAiToolBlock) };
  return event;
};
