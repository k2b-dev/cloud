import type { ChatCommand } from "./ChatComposer";
import type { ChatAction } from "./types";

export const nextChatCommandIndex = (index: number, length: number, direction: 1 | -1): number =>
  length <= 0 ? 0 : (index + direction + length) % length;

export const isChatNearBottom = (scrollHeight: number, scrollTop: number, clientHeight: number, threshold = 96): boolean =>
  scrollHeight - scrollTop - clientHeight <= threshold;

export const restoredChatScrollTop = (previousScrollTop: number, previousScrollHeight: number, nextScrollHeight: number): number =>
  Math.max(0, previousScrollTop + nextScrollHeight - previousScrollHeight);

export type ChatSubmissionRun = {
  /** Clears the controlled draft (and attachments) before the handler runs. */
  clear: () => void;
  /**
   * The application handler. A synchronous throw, a rejected promise, and a
   * `false` result all count as a rejected submission.
   */
  perform: () => boolean | void | Promise<boolean | void>;
  /** Restores the cleared draft (and attachments) after a rejected submission. */
  restore: () => void;
  onError?: (error: unknown) => void;
};

/**
 * Runs one composer submission with optimistic clearing. Resolves to `true`
 * when the handler accepted the submission. A synchronous throw is handled
 * exactly like a rejected promise so a controlled draft is never lost.
 */
export const runChatSubmission = async (run: ChatSubmissionRun): Promise<boolean> => {
  run.clear();
  try {
    if ((await run.perform()) === false) {
      run.restore();
      return false;
    }
    return true;
  } catch (error) {
    run.onError?.(error);
    run.restore();
    return false;
  }
};

/** Reports a handler failure without letting a synchronous throw escape. */
export const reportChatFailure = (perform: () => unknown, onError?: (error: unknown) => void): void => {
  try {
    const result = perform();
    if (result instanceof Promise) void result.catch((error) => onError?.(error));
  } catch (error) {
    onError?.(error);
  }
};

const writeChatClipboard = async (value: string): Promise<void> => {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    throw new Error("Clipboard access is unavailable.");
  }
  await navigator.clipboard.writeText(value);
};

/** Executes the one behavior guaranteed by the ChatAction contract. */
export const executeChatAction = async (action: ChatAction): Promise<void> => {
  if (typeof action.copyText === "string") {
    await writeChatClipboard(action.copyText);
    return;
  }
  await action.onSelect();
};

export type ChatEnterKey = { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean };

/**
 * What Enter does in a conversation composer: Ctrl/⌘+Enter always sends; Shift+Enter, Enter inside an open code
 * block, and Enter on a touch-only device break the line; otherwise `sendKey` decides. IME input is the caller's check.
 */
export const conversationEnterAction = (
  key: ChatEnterKey,
  context: { sendKey: "enter" | "mod-enter"; touchOnly: boolean; inCodeBlock: boolean },
): "send" | "newline" => {
  if (key.ctrlKey || key.metaKey) return "send";
  if (key.shiftKey || key.altKey || context.touchOnly || context.inCodeBlock || context.sendKey === "mod-enter") return "newline";
  return "send";
};

export type ChatSuggestionKey = ChatEnterKey & { key: string; isComposing: boolean; keyCode: number };

/**
 * What a key does to a suggested next message that stands in the empty field: a plain Tab accepts it and a plain
 * Escape dismisses it. Tab with a modifier, a key that confirms an input method's composition, and any key while a
 * command, emoji or people list is open keep their usual meaning.
 */
export const chatSuggestionKeyAction = (
  key: ChatSuggestionKey,
  context: { composing: boolean; listOpen: boolean },
): "accept" | "dismiss" | undefined => {
  if (key.isComposing || key.keyCode === 229 || context.composing || context.listOpen) return undefined;
  if (key.shiftKey || key.altKey || key.ctrlKey || key.metaKey) return undefined;
  if (key.key === "Tab") return "accept";
  if (key.key === "Escape") return "dismiss";
  return undefined;
};

/** Case- and accent-insensitive text for command discovery. */
export const foldChatSearchText = (text: string): string => text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss");

export const chatCommandKey = (command: ChatCommand): string => command.id ?? command.name;
