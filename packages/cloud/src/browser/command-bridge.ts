import type { GlobalSearchOptions } from "./search-bridge";
import type { z } from "zod";
import type { CommandOptions } from "../contracts/commands";

export type CommandTarget = { command: string; input: unknown; options?: CommandOptions };
export type ContextAwareCommand = {
  id: string;
  title: string;
  description: string;
  icon?: string;
  /** One platform-aware key combination, for example mod+shift+k. */
  shortcut?: string;
  /** A linkable app Command, an in-place search, or a local UI interaction. */
  action: CommandTarget | { search: GlobalSearchOptions } | (() => void | Promise<void>);
};
type HandleRequest = { target: CommandTarget; handlers: Array<() => void | Promise<void>> };
type CollectRequest = { commands: ContextAwareCommand[] };
const HANDLE = "cloud.command.handle";
const COLLECT = "cloud.command.collect";
const EXECUTE = "cloud.command.execute";
type ExecuteRequest = { command: ContextAwareCommand; run: () => Promise<void>; result?: Promise<void> };
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
  let active = true;
  let pending: Promise<void> | undefined;
  const registered = { ...command };
  const execute = (event: Event) => {
    const request = (event as CustomEvent<ExecuteRequest>).detail;
    if (request.command.id !== registered.id || request.command.action !== registered.action) return;
    if (pending) {
      request.result = Promise.resolve();
      return;
    }
    pending = Promise.resolve()
      .then(() => {
        if (!active) throw new Error("Command context is no longer available");
        return request.run();
      })
      .finally(() => {
        pending = undefined;
      });
    request.result = pending;
  };
  const listener = (event: Event) => {
    const request = (event as CustomEvent<CollectRequest>).detail;
    request.commands.push(registered);
  };
  window.addEventListener(COLLECT, listener);
  window.addEventListener(EXECUTE, execute);
  window.dispatchEvent(new Event(COMMANDS_CHANGED));
  return () => {
    active = false;
    window.removeEventListener(COLLECT, listener);
    window.removeEventListener(EXECUTE, execute);
    window.dispatchEvent(new Event(COMMANDS_CHANGED));
  };
};
export const collectContextAwareCommands = (): ContextAwareCommand[] => {
  if (typeof window === "undefined") return [];
  const detail: CollectRequest = { commands: [] };
  window.dispatchEvent(new CustomEvent(COLLECT, { detail }));
  // Ambiguous IDs are not executable, regardless of island hydration order.
  return detail.commands.filter((command) => detail.commands.filter((other) => other.id === command.id).length === 1);
};

export const requestContextCommandExecution = (command: ContextAwareCommand, run: () => Promise<void>): Promise<void> | undefined => {
  const detail: ExecuteRequest = { command, run };
  window.dispatchEvent(new CustomEvent(EXECUTE, { detail }));
  return detail.result;
};
