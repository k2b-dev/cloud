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
