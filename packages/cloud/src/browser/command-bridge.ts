import type { z } from "zod";
import type { CommandOptions } from "../contracts/commands";

export type CommandTarget = { command: string; input: unknown; options?: CommandOptions };
export type ContextAwareCommand = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  /** A linkable app Command, or a local UI interaction. */
  action: CommandTarget | (() => void | Promise<void>);
};
type HandleRequest = { target: CommandTarget; handlers: Array<() => void | Promise<void>> };
type CollectRequest = { commands: ContextAwareCommand[] };
const HANDLE = "cloud.command.handle";
const COLLECT = "cloud.command.collect";
export const COMMANDS_CHANGED = "cloud.command.changed";

/** Document events work across independently hydrated islands and bundles. */
export const registerCommandHandler = <S extends z.ZodType>(
  command: string,
  schema: S,
  handler: (input: z.output<S>, options: CommandOptions) => void | Promise<void>,
  accepts: (input: z.output<S>) => boolean = () => true,
): (() => void) => {
  let active = true;
  const listener = (event: Event) => {
    const request = (event as CustomEvent<HandleRequest>).detail;
    if (request.target.command !== command) return;
    const parsed = schema.safeParse(request.target.input);
    if (!parsed.success || !accepts(parsed.data)) return;
    // Collect owners before invoking one, so overlapping islands cannot choose by listener order.
    request.handlers.push(() => {
      if (!active) throw new Error("Command context is no longer available");
      return handler(parsed.data, request.target.options ?? {});
    });
  };
  window.addEventListener(HANDLE, listener);
  return () => {
    active = false;
    window.removeEventListener(HANDLE, listener);
  };
};
export const requestCommandHandling = (target: CommandTarget): Promise<void> | undefined => {
  const detail: HandleRequest = { target, handlers: [] };
  window.dispatchEvent(new CustomEvent(HANDLE, { detail }));
  if (detail.handlers.length > 1) return Promise.reject(new Error("Multiple Command owners accepted the request"));
  const handler = detail.handlers[0];
  return handler ? Promise.resolve().then(handler) : undefined;
};

/** Register within a reactive effect and dispose it when the visible context changes. */
export const registerContextAwareCommand = (command: ContextAwareCommand): (() => void) => {
  const listener = (event: Event) => {
    const request = (event as CustomEvent<CollectRequest>).detail;
    if (!request.commands.some((item) => item.id === command.id)) request.commands.push(command);
  };
  window.addEventListener(COLLECT, listener);
  window.dispatchEvent(new Event(COMMANDS_CHANGED));
  return () => {
    window.removeEventListener(COLLECT, listener);
    window.dispatchEvent(new Event(COMMANDS_CHANGED));
  };
};
export const collectContextAwareCommands = (): ContextAwareCommand[] => {
  const detail: CollectRequest = { commands: [] };
  window.dispatchEvent(new CustomEvent(COLLECT, { detail }));
  return detail.commands;
};
