import type { ChatCommand, ChatCommandDraft, ChatCommandOpenResult } from "@k2b/ui";
import { CAPABILITY_FRAMEWORK_ERROR_CODES } from "../contracts/capabilities";
import { isCommandPath } from "../contracts/command-path";
import { openCommand } from "./commands";
import type { CloudComposerCatalogState, CloudComposerCommand } from "./composer-catalog";
import { composerOpenMessages } from "./composer-open-messages";

export type OpenComposerCommandOptions = {
  before: () => Promise<void>;
  returnTo: () => string | undefined;
  /** Read after `before`; once it aborts, for example because the person left the chat, nothing opens. */
  signal?: () => AbortSignal | undefined;
  locale: string;
};

/**
 * Save first, then resolve and open. If nothing opens, cancel so the composer keeps its token and restores the live draft.
 * Save errors reach the status line; resolution errors stay on the retryable row.
 */
export const openComposerCommand = async (
  command: CloudComposerCommand,
  options: OpenComposerCommandOptions,
): Promise<ChatCommandOpenResult> => {
  await options.before();
  const signal = options.signal?.();
  if (signal?.aborted) return "cancelled";
  const returnTo = options.returnTo();
  if (returnTo !== undefined && !isCommandPath(returnTo)) throw new Error("Invalid Command return path");
  try {
    if (!(await openCommand(command.id, command.input, { returnTo }, signal))) return "cancelled";
  } catch (error) {
    if (signal?.aborted) return "cancelled";
    const cause = error instanceof Error ? error.cause : undefined;
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string" &&
      "status" in cause &&
      typeof cause.status === "number" &&
      "message" in cause &&
      typeof cause.message === "string" &&
      cause.code !== CAPABILITY_FRAMEWORK_ERROR_CODES.appUnavailable &&
      ![502, 503, 504].includes(cause.status) &&
      cause.message
    ) {
      return { failed: cause.message };
    }
    return { failed: composerOpenMessages.resolve([options.locale]).t.appUnavailable({ app: command.appName }) };
  }
  if (signal?.aborted) return "cancelled";
};

export type CloudCommandMenuOptions = {
  locale: string;
  commands: readonly CloudComposerCommand[];
  state: CloudComposerCatalogState;
  section?: string;
  before: (draft: ChatCommandDraft, signal: AbortSignal, follow: () => void) => Promise<void>;
  returnTo: () => string | undefined;
  /** See `OpenComposerCommandOptions.signal`. */
  signal?: () => AbortSignal | undefined;
};
export type CloudCommandMenu = { commands: ChatCommand[]; pending: boolean };

/** Put this section last. Pending placeholders reserve its end; a failed catalog offers one explicit reload. */
export const cloudCommandMenu = (options: CloudCommandMenuOptions): CloudCommandMenu => {
  const t = composerOpenMessages.resolve([options.locale]).t;
  if (options.state === "loading") return { commands: [], pending: true };
  if (options.state === "failed")
    return {
      commands: [
        {
          id: "cloud-commands-retry",
          name: "cloud-commands-retry",
          label: t.commandsFailed,
          description: t.tryAgain,
          icon: "ti ti-alert-circle",
          searchAgain: true,
          persistent: true,
          section: options.section,
        },
      ],
      pending: false,
    };
  return {
    commands: options.commands.map((command) => ({
      id: `cloud-command:${command.id}`,
      name: command.id,
      label: command.title,
      description: `${command.appName} · ${command.description}`,
      icon: command.icon,
      keywords: [command.title, ...command.keywords, command.appName, command.description],
      app: command.appName,
      section: options.section,
      // The composer's signal aborts when the person closes the list; the opener's, when it leaves the chat.
      open: (draft, closed, follow) =>
        openComposerCommand(command, {
          before: () => options.before(draft, closed, follow),
          returnTo: options.returnTo,
          signal: () => {
            const left = options.signal?.();
            return left ? AbortSignal.any([closed, left]) : closed;
          },
          locale: options.locale,
        }),
    })),
    pending: false,
  };
};
