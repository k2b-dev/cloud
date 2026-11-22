/** Whether resolved children render something; a Show whose condition is false, or a boolean, renders nothing. */
export const rendersSomething = (nodes: unknown[]): boolean =>
  nodes.some((node) => node != null && typeof node !== "boolean" && node !== "");
