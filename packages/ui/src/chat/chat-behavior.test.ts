import { describe, expect, test } from "bun:test";
import {
  executeChatAction,
  isChatNearBottom,
  nextChatCommandIndex,
  reportChatFailure,
  restoredChatScrollTop,
  runChatSubmission,
} from "./chat-behavior";
import type { ChatAttachment } from "./types";

type Draft = { value: string; attachments: readonly ChatAttachment[] };

const composerDraft = (): Draft => ({
  value: "Ship the release notes",
  attachments: [{ id: "notes", name: "notes.md" }],
});

const submission = (draft: Draft, perform: () => boolean | void | Promise<boolean | void>, onError?: (error: unknown) => void) => {
  const previous = { ...draft };
  return runChatSubmission({
    clear: () => {
      draft.value = "";
      draft.attachments = [];
    },
    perform,
    restore: () => {
      draft.value = previous.value;
      draft.attachments = previous.attachments;
    },
    onError,
  });
};

describe("@k2b/ui chat behavior", () => {
  test("executes the one behavior declared by a chat action", async () => {
    const selected: string[] = [];

    await executeChatAction({
      id: "retry",
      label: "Retry",
      onSelect: () => {
        selected.push("retry");
      },
    });

    expect(selected).toEqual(["retry"]);
  });

  test("wraps slash command navigation in both directions", () => {
    expect(nextChatCommandIndex(0, 3, 1)).toBe(1);
    expect(nextChatCommandIndex(2, 3, 1)).toBe(0);
    expect(nextChatCommandIndex(0, 3, -1)).toBe(2);
    expect(nextChatCommandIndex(0, 0, 1)).toBe(0);
  });

  test("uses a configurable follow threshold", () => {
    expect(isChatNearBottom(1_000, 820, 100)).toBe(true);
    expect(isChatNearBottom(1_000, 700, 100)).toBe(false);
    expect(isChatNearBottom(1_000, 750, 100, 160)).toBe(true);
  });

  test("preserves the visible position when history is prepended", () => {
    expect(restoredChatScrollTop(80, 600, 900)).toBe(380);
    expect(restoredChatScrollTop(0, 900, 600)).toBe(0);
  });

  test("clears the draft optimistically and keeps it cleared on success", async () => {
    const draft = composerDraft();
    const observed: string[] = [];

    const accepted = await submission(draft, () => {
      observed.push(draft.value);
      return undefined;
    });

    expect(accepted).toBe(true);
    expect(observed).toEqual([""]);
    expect(draft.value).toBe("");
    expect(draft.attachments).toEqual([]);
  });

  test("restores the draft and attachments when the handler returns false", async () => {
    const draft = composerDraft();

    const accepted = await submission(draft, () => false);

    expect(accepted).toBe(false);
    expect(draft.value).toBe("Ship the release notes");
    expect(draft.attachments).toEqual([{ id: "notes", name: "notes.md" }]);
  });

  test("restores the draft and reports a rejected promise", async () => {
    const draft = composerDraft();
    const errors: unknown[] = [];
    const failure = new Error("network unavailable");

    const accepted = await submission(
      draft,
      () => Promise.reject(failure),
      (error) => errors.push(error),
    );

    expect(accepted).toBe(false);
    expect(errors).toEqual([failure]);
    expect(draft.value).toBe("Ship the release notes");
    expect(draft.attachments).toHaveLength(1);
  });

  test("restores the draft and reports a synchronous throw", async () => {
    const draft = composerDraft();
    const errors: unknown[] = [];
    const failure = new Error("handler exploded");

    const accepted = await submission(
      draft,
      () => {
        throw failure;
      },
      (error) => errors.push(error),
    );

    expect(accepted).toBe(false);
    expect(errors).toEqual([failure]);
    expect(draft.value).toBe("Ship the release notes");
    expect(draft.attachments).toHaveLength(1);
  });

  test("keeps a rejected submission silent when no reporter is supplied", async () => {
    const draft = composerDraft();

    await expect(
      submission(draft, () => {
        throw new Error("handler exploded");
      }),
    ).resolves.toBe(false);
    expect(draft.value).toBe("Ship the release notes");
  });

  test("reports stop failures without letting them escape", async () => {
    const errors: unknown[] = [];

    reportChatFailure(
      () => {
        throw new Error("sync stop failure");
      },
      (error) => errors.push(error),
    );
    reportChatFailure(
      () => Promise.reject(new Error("async stop failure")),
      (error) => errors.push(error),
    );
    await Promise.resolve();

    expect(errors.map((error) => (error as Error).message)).toEqual(["sync stop failure", "async stop failure"]);
    expect(() => reportChatFailure(() => undefined)).not.toThrow();
  });
});
