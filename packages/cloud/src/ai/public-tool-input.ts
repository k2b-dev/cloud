import { CODE_RUNTIME_TOOL_NAMES } from "./browser-code-contracts";
import type { AiTurnBlock, AiWireEvent } from "./protocol";

/** Source maps, bundles, declarations and diff rows belong to execution, never to public Code details. */
const withoutCodeSource = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutCodeSource);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          !["content", "bundle", "declarations", "lines"].includes(key) &&
          !(["files", "tests"].includes(key) && item !== null && typeof item === "object" && !Array.isArray(item)),
      )
      .map(([key, item]) => [
        key,
        ["project", "diff", "result", "error", "details", "items", "files"].includes(key) ? withoutCodeSource(item) : item,
      ]),
  );
};

/** Execution keeps original arguments; chat, history and pending reads receive only their public fields. */
export function publicAiToolInput(name: string, args: Record<string, unknown>): Record<string, unknown>;
export function publicAiToolInput(name: string, args: unknown): unknown;
export function publicAiToolInput(name: string, args: unknown): unknown {
  if (!name.startsWith("code_") || args === null || typeof args !== "object" || Array.isArray(args)) return args;
  return Object.fromEntries(
    Object.entries(args)
      .filter(([key]) => !(name === "code_run" && key === "code") && !["content", "files", "tests"].includes(key))
      .map(([key, value]) => [key, key === "project" ? withoutCodeSource(value) : value]),
  );
}

export const publicAiToolResult = (name: string, result: unknown): unknown =>
  name.startsWith("code_") && !CODE_RUNTIME_TOOL_NAMES.some((tool) => tool === name) ? withoutCodeSource(result) : result;

export const publicAiToolBlock = (block: AiTurnBlock): AiTurnBlock =>
  block.kind === "tool"
    ? { ...block, args: publicAiToolInput(block.name, block.args), result: publicAiToolResult(block.name, block.result) }
    : block;

/** Covers live steps and a resumed turn's baseline, including events saved by an earlier worker. */
export const publicAiToolEvent = (event: AiWireEvent): AiWireEvent => {
  if (event.type === "block_set") return { ...event, block: publicAiToolBlock(event.block) };
  if (event.type === "turn_started" && event.blocks) return { ...event, blocks: event.blocks.map(publicAiToolBlock) };
  return event;
};
