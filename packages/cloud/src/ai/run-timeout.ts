/** Preserve why execution stopped instead of reporting an operator deadline as a user abort. */
export class AiRunTimeout extends Error {
  constructor(readonly budgetMs: number | null) {
    super("AI_RUN_TIMEOUT");
  }
  messageFor(locale?: string): string {
    const minutes = this.budgetMs ? this.budgetMs / 60_000 : null;
    return locale?.startsWith("de")
      ? `Laufzeitlimit${minutes ? ` von ${minutes} Minuten` : ""} erreicht. Du kannst die Aufgabe mit einer neuen Nachricht fortsetzen.`
      : `Run time limit${minutes ? ` of ${minutes} minutes` : ""} reached. You can continue the task with a new message.`;
  }
}
