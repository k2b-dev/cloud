export const isRetiredRoutineConfig = (config: unknown): boolean =>
  config !== null && typeof config === "object" && (Object.hasOwn(config, "background") || Object.hasOwn(config, "mandate"));

/** Old configs remain readable as evidence, but never regain execution authority. */
export function assertInteractiveChatTurn(config: unknown): void {
  if (isRetiredRoutineConfig(config)) throw new Error("Scheduled chat routines are retired. Rebuild the routine as reviewed Code.");
}
