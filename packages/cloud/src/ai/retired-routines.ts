/** Old configs remain readable as evidence, but never regain execution authority. */
export function assertInteractiveChatTurn(config: unknown): void {
  if (config && typeof config === "object" && (Object.hasOwn(config, "background") || Object.hasOwn(config, "mandate")))
    throw new Error("Scheduled chat routines are retired. Rebuild the routine as reviewed Code.");
}
