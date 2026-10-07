import type { AiTurnError } from "./types";

/** Preserve why execution stopped instead of reporting an operator deadline as a user abort. */
export class AiRunTimeout extends Error {
  constructor(readonly budgetMs: number | null) {
    super("AI_RUN_TIMEOUT");
  }
  turnError(): AiTurnError {
    return this.budgetMs ? { code: "time_limit", limitMinutes: Math.round(this.budgetMs / 60_000) } : { code: "time_limit" };
  }
}
