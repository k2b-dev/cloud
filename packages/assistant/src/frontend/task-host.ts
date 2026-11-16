import type { AiTurnStatus } from "@k2b/cloud/ai";
import type { ChatTask } from "@k2b/ui";

/** The person's own choice for the plan above the field, kept per chat for the session. */
export type TaskHostChoice = "open" | "closed" | null;

/**
 * Whether the plan above the field is open (Bauplan 3a): open while Gustav works on it, unless the person closed it;
 * once every task is done it folds, unless the person opened it.
 */
export const taskHostOpen = (state: { hasOpenTasks: boolean; choice: TaskHostChoice }): boolean =>
  state.hasOpenTasks ? state.choice !== "closed" : state.choice === "open";

/**
 * Whether a finished plan keeps its folded "All tasks done" header: when it just finished in this chat, or when the person
 * opened it. A plan that was already done when the chat opened stays behind "Show tasks".
 */
export const finishedPlanShown = (state: { finishedHere: boolean; choice: TaskHostChoice }): boolean =>
  state.finishedHere || state.choice === "open";

/**
 * The plan as shown: a step is current only while a turn still works on it, running, queued, or waiting for the person.
 * Once the turn ended without finishing the plan (interrupted, stopped, or done), nothing runs, and the step it stood at
 * shows as open again.
 */
export const shownTasks = <T extends { status: ChatTask["status"] }>(items: readonly T[], turn: AiTurnStatus | undefined): readonly T[] =>
  turn === "running" || turn === "queued" || turn === "waiting_for_action"
    ? items
    : items.map((item) => (item.status === "in_progress" ? { ...item, status: "pending" } : item));
