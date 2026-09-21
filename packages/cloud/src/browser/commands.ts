import { toast } from "@k2b/ui";
import { resolveCommand } from "../capabilities/client";
import { type CommandOptions, CommandOptionsSchema, clearCommand, readCommand } from "../contracts/commands";
import {
  type ContextAwareCommand,
  collectContextAwareCommands,
  requestCommandHandling,
  requestContextCommandExecution,
} from "./command-bridge";
import { resourceSearchMessages } from "./resource-search-messages";
import { requestGlobalSearch } from "./search-bridge";

export type { CommandOptions } from "../contracts/commands";
export type { CommandTarget, ContextAwareCommand } from "./command-bridge";
export { registerCommandHandler, registerContextAwareCommand } from "./command-bridge";

/** Opens locally only when a mounted owner explicitly accepts; otherwise follows the app's URL. */
export const openCommand = async (command: string, input: unknown = {}, options: CommandOptions = {}): Promise<void> => {
  const parsedOptions = CommandOptionsSchema.parse(options);
  const handled = requestCommandHandling({ command, input, options: parsedOptions });
  if (handled) return handled;
  const result = await resolveCommand(command, input, parsedOptions);
  if (!result.ok) throw new Error(result.error.message);
  window.location.assign(result.data.href);
};

/** Call after this page's handlers have mounted. Each entry is consumed, including invalid links. */
export const consumeCommandLink = async (): Promise<void> => {
  const url = new URL(window.location.href);
  const messages = resourceSearchMessages.resolve([document.documentElement.lang]).t;
  let target: ReturnType<typeof readCommand>;
  try {
    target = readCommand(url);
  } catch {
    window.history.replaceState(window.history.state, "", clearCommand(url));
    toast.error(messages.commandFailed);
    return;
  }
  if (!target) return;
  window.history.replaceState(window.history.state, "", clearCommand(url));
  try {
    const handled = requestCommandHandling({ command: target.id, input: target.input, options: target.options });
    if (!handled) {
      toast.error(messages.commandUnavailable);
      return;
    }
    await handled;
  } catch (error) {
    toast.error(error instanceof Error && error.message ? error.message : messages.commandFailed);
  }
};

/** The palette and keyboard share live ownership checks, pending guards and error feedback. */
export const runContextAwareCommand = async (command: ContextAwareCommand): Promise<void> => {
  const messages = resourceSearchMessages.resolve([document.documentElement.lang]).t;
  try {
    const current = collectContextAwareCommands().find((item) => item.id === command.id && item.action === command.action);
    if (!current) throw new Error(messages.commandUnavailable);
    await requestContextCommandExecution(current, async () => {
      if (typeof current.action === "function") await current.action();
      else if ("search" in current.action) await requestGlobalSearch({ query: "", ...current.action.search });
      else await openCommand(current.action.command, current.action.input, current.action.options);
    });
  } catch (error) {
    toast.error(error instanceof Error && error.message ? error.message : messages.commandFailed);
  }
};
