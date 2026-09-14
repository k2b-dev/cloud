import { AiTodoPlanSchema } from "./todo-contracts";
import { defineAiTool } from "./tools";

export const createAiTodoTool = () => defineAiTool({
  name: "todo_write",
  description: "Replace the complete working plan for this chat. Use short actionable tasks with stable IDs; preserve IDs when editing or reordering. At most one task may be in_progress. Update when starting or finishing real steps and when user instructions change the plan. Mark completed only after doing and verifying the work. Keep blocked work open and explain the blocker; no task needs to be active while waiting for the user. Use todos:[] to clear. This records progress only; it does not execute or authorize work. Up to 50 tasks, 500 characters per task.",
  promptHint: "For complex work with several real steps, maintain a working plan with todo_write. Skip trivial questions. Keep status current, and verify work before marking it completed.",
  inputSchema: AiTodoPlanSchema,
  outputSchema: AiTodoPlanSchema,
  approval: "never",
}).server(async (input, context) => {
  if (!context.conversationId || !context.turnId) throw new Error("A running conversation is required.");
  // The runtime persists this validated result with the originating turn.
  // It is the canonical plan checkpoint, including for replay, retry and fork.
  return input;
});
