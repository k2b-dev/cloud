import { toast } from "@k2b/ui";
import type { CommandOptions } from "../contracts/commands";
import {
  type ContextAwareCommand,
  collectContextAwareCommands,
  requestCommandHandling,
  requestContextCommandExecution,
} from "./command-bridge";
import { importOnDemand } from "./reload";
import { resourceSearchMessages } from "./resource-search-messages";
import { requestGlobalSearch } from "./search-bridge";

export type { CommandOptions } from "../contracts/commands";
export type { CommandTarget, ContextAwareCommand } from "./command-bridge";
export { registerCommandHandler, registerContextAwareCommand } from "./command-bridge";

/**
 * Opens locally only when a mounted owner accepts; otherwise follows the app's URL.
 * Resolves true after the owner's handler resolves or navigation starts.
 * Resolves false if code cannot load (with a reload notice) or `signal` aborts before handling or while resolving the link.
 * An accepting owner takes over without the signal. Handler rejections and link resolution failures still reject.
 */
export const openCommand = async (
  command: string,
  input: unknown = {},
  options: CommandOptions = {},
  signal?: AbortSignal,
): Promise<boolean> => {
  const modules = await importOnDemand(() => Promise.all([import("../contracts/commands"), import("../capabilities/client")]));
  if (!modules || signal?.aborted) return false;
  const [contracts, capabilities] = modules;
  const parsedOptions = contracts.CommandOptionsSchema.parse(options);
  const handled = requestCommandHandling({ command, input, options: parsedOptions });
  if (handled) {
    await handled;
    return true;
  }
  // An abort also ends the request, so a cancelled opening does not wait for its answer.
  const result = await capabilities.resolveCommand(command, input, parsedOptions, { signal });
  if (signal?.aborted) return false;
  if (!result.ok) throw new Error(result.error.message, { cause: result.error });
  window.location.assign(result.data.href);
  return true;
};

/** Call after this page's handlers have mounted. Each entry is consumed, including invalid links. */
export const consumeCommandLink = async (): Promise<void> => {
  const command = new URL(window.location.href).searchParams.get("command");
  if (!command) return;
  const contracts = await importOnDemand(() => import("../contracts/commands"));
  if (!contracts) return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("command") !== command) return;
  const { clearCommand, readCommand } = contracts;
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
