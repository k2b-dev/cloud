import { toast } from "@k2b/ui";
import { resolveCommand } from "../capabilities/client";
import { clearCommand, CommandOptionsSchema, readCommand, type CommandOptions } from "../contracts/commands";
import { resourceSearchMessages } from "./resource-search-messages";
import { requestCommandHandling } from "./command-bridge";
export { registerCommandHandler, registerContextAwareCommand } from "./command-bridge";
export type { CommandTarget, ContextAwareCommand } from "./command-bridge";
export type { CommandOptions } from "../contracts/commands";

/** Opens locally only when a mounted owner explicitly accepts; otherwise follows the app's URL. */
export const openCommand = async (command: string, input: unknown = {}, options: CommandOptions = {}): Promise<void> => {
  const parsedOptions = CommandOptionsSchema.parse(options);
  const handled = requestCommandHandling({ command, input, options: parsedOptions });
  if (handled) return handled;
  const result = await resolveCommand(command, input, parsedOptions);
  if (!result.ok) throw new Error(result.error.message);
  window.location.assign(result.data.href);
};

/** Call after this page's handlers have mounted. Invalid entries remain visible as an error, never a mutation. */
export const consumeCommandLink = async (): Promise<void> => {
  const url = new URL(window.location.href);
  try {
    const target = readCommand(url);
    if (!target) return;
    const handled = requestCommandHandling({ command: target.id, input: target.input, options: target.options });
    if (!handled) throw new Error("Command context is unavailable");
    // Consume before showing interactive UI, preventing reload/back from reopening it.
    window.history.replaceState(window.history.state, "", clearCommand(url));
    await handled;
  } catch {
    toast.error(resourceSearchMessages.resolve([document.documentElement.lang]).t.commandFailed);
  }
};
