import { describe, expect, test } from "bun:test";
import { createMailActionOutcomes, MAIL_ACTION_OUTCOME_TTL_MS } from "./mail-action-outcomes";

describe("Mail action outcomes", () => {
  // Archive two conversations: one message in the Inbox, and one conversation filed in the Inbox and Projects.
  const archiveTwo = (outcomes: ReturnType<typeof createMailActionOutcomes>, now = Date.now()) =>
    outcomes.follow({
      actionId: "archive",
      destinationFolderId: null,
      conversations: [
        { conversationId: "c1", label: "Quarterly report", commands: [{ id: "m1", state: "queued", sourceFolderId: "inbox" }] },
        {
          conversationId: "c2",
          label: "Team lunch",
          commands: [
            { id: "m2", state: "queued", sourceFolderId: "inbox" },
            { id: "m3", state: "queued", sourceFolderId: "projects" },
          ],
        },
      ],
      now,
    });

  test("reports a queued archive that fails later, once every command finished, with the folder where it failed", () => {
    const outcomes = createMailActionOutcomes();
    expect(archiveTwo(outcomes)).toBeNull();
    expect(outcomes.pendingCommandIds()).toEqual(["m1", "m2", "m3"]);

    expect(
      outcomes.apply(
        ["m1", "m2", "m3"],
        [
          { id: "m1", state: "confirmed", code: null },
          { id: "m2", state: "failed", code: "REMOTE_MESSAGE_MISSING" },
          { id: "m3", state: "executing", code: null },
        ],
      ),
    ).toEqual([]);
    expect(outcomes.pendingCommandIds()).toEqual(["m3"]);

    // Projects was archived, so Try again repeats the change in the Inbox only.
    expect(outcomes.apply(["m3"], [{ id: "m3", state: "confirmed", code: null }])).toEqual([
      {
        actionId: "archive",
        destinationFolderId: null,
        conversationCount: 2,
        failures: [{ conversationId: "c2", label: "Team lunch", sourceFolderIds: ["inbox"], code: "REMOTE_MESSAGE_MISSING" }],
      },
    ]);
    expect(outcomes.hasPending()).toBe(false);
  });

  test("reports an unclear outcome even after a definite failure in the same conversation", () => {
    const outcomes = createMailActionOutcomes();
    archiveTwo(outcomes);
    const [report] = outcomes.apply(
      ["m1", "m2", "m3"],
      [
        { id: "m1", state: "confirmed", code: null },
        { id: "m2", state: "failed", code: "REMOTE_MESSAGE_MISSING" },
        { id: "m3", state: "needs_attention", code: "AMBIGUOUS_DELETE" },
      ],
    );
    // The workspace offers no Try again for an unclear change, so it must not be hidden.
    expect(report?.failures).toEqual([
      { conversationId: "c2", label: "Team lunch", sourceFolderIds: ["inbox", "projects"], code: "needs_attention" },
    ]);
  });

  test("names a cancelled or unclear command by its state", () => {
    const outcomes = createMailActionOutcomes();
    archiveTwo(outcomes);
    const [report] = outcomes.apply(
      ["m1", "m2", "m3"],
      [
        { id: "m1", state: "cancelled", code: null },
        { id: "m2", state: "needs_attention", code: "AMBIGUOUS_DELETE" },
        { id: "m3", state: "confirmed", code: null },
      ],
    );
    expect(report?.failures.map((failure) => failure.code)).toEqual(["cancelled", "needs_attention"]);
  });

  test("stays silent when everything applied, including commands the server no longer keeps", () => {
    const outcomes = createMailActionOutcomes();
    archiveTwo(outcomes);
    expect(outcomes.apply(["m1", "m2", "m3"], [{ id: "m2", state: "reconciled", code: null }])).toEqual([]);
    expect(outcomes.hasPending()).toBe(false);
  });

  test("keeps a command that waits for a retry pending", () => {
    const outcomes = createMailActionOutcomes();
    archiveTwo(outcomes);
    outcomes.apply(["m1"], [{ id: "m1", state: "queued", code: "IMAP_CONNECTION_LOST" }]);
    expect(outcomes.pendingCommandIds()).toEqual(["m1", "m2", "m3"]);
  });

  test("reports right away when the request returned finished commands", () => {
    const outcomes = createMailActionOutcomes();
    const report = outcomes.follow({
      actionId: "mark_read",
      destinationFolderId: null,
      conversations: [
        { conversationId: "c1", label: "Quarterly report", commands: [{ id: "m1", state: "failed", code: null, sourceFolderId: "inbox" }] },
      ],
    });
    expect(report?.failures).toEqual([{ conversationId: "c1", label: "Quarterly report", sourceFolderIds: ["inbox"], code: "failed" }]);
    expect(outcomes.hasPending()).toBe(false);
  });

  test("asks for at most one batch and rotates so waiting commands cannot hide the others", () => {
    const outcomes = createMailActionOutcomes();
    archiveTwo(outcomes);
    expect(outcomes.pendingCommandIds(2)).toEqual(["m1", "m2"]);
    expect(outcomes.pendingCommandIds(2)).toEqual(["m3", "m1"]);
    expect(outcomes.pendingCommandIds(2)).toEqual(["m2", "m3"]);
  });

  test("stops following after the TTL, even when no request succeeded, and still reports what failed", () => {
    const outcomes = createMailActionOutcomes();
    archiveTwo(outcomes, 0);
    expect(
      outcomes.apply(
        ["m1", "m2", "m3"],
        [
          { id: "m1", state: "failed", code: "PROVIDER_RIGHTS_CHANGED" },
          { id: "m2", state: "failed", code: "PROVIDER_RIGHTS_CHANGED" },
          { id: "m3", state: "ambiguous", code: null },
        ],
        1,
      ),
    ).toEqual([]);
    // Failed requests apply nothing, but the lifetime still runs out.
    expect(outcomes.apply([], [], MAIL_ACTION_OUTCOME_TTL_MS - 1)).toEqual([]);
    expect(outcomes.hasPending()).toBe(true);
    expect(outcomes.apply([], [], MAIL_ACTION_OUTCOME_TTL_MS)).toEqual([
      {
        actionId: "archive",
        destinationFolderId: null,
        conversationCount: 2,
        failures: [
          { conversationId: "c1", label: "Quarterly report", sourceFolderIds: ["inbox"], code: "PROVIDER_RIGHTS_CHANGED" },
          // Its other change never finished, so it is unclear and not offered again.
          { conversationId: "c2", label: "Team lunch", sourceFolderIds: ["inbox"], code: "needs_attention" },
        ],
      },
    ]);
    expect(outcomes.hasPending()).toBe(false);
  });

  test("calls a conversation unclear at expiry when no request could check its commands in time", () => {
    const outcomes = createMailActionOutcomes();
    archiveTwo(outcomes, 0);
    // Only m1 was ever asked about and still waits for the mailbox; m2 and m3 were never checked.
    expect(outcomes.apply(["m1"], [{ id: "m1", state: "queued", code: null }], 1)).toEqual([]);
    expect(outcomes.apply([], [], MAIL_ACTION_OUTCOME_TTL_MS)).toEqual([
      {
        actionId: "archive",
        destinationFolderId: null,
        conversationCount: 2,
        failures: [{ conversationId: "c2", label: "Team lunch", sourceFolderIds: [], code: "needs_attention" }],
      },
    ]);
  });

  test("keeps the messages a message-list action was limited to, so Try again repeats only those", () => {
    const outcomes = createMailActionOutcomes();
    const report = outcomes.follow({
      actionId: "trash",
      destinationFolderId: null,
      conversations: [
        {
          conversationId: "c1",
          label: "Quarterly report",
          messageIds: ["message-a"],
          commands: [{ id: "m1", state: "failed", code: "REMOTE_MESSAGE_MISSING", sourceFolderId: "inbox" }],
        },
      ],
    });
    expect(report?.failures).toEqual([
      {
        conversationId: "c1",
        label: "Quarterly report",
        sourceFolderIds: ["inbox"],
        messageIds: ["message-a"],
        code: "REMOTE_MESSAGE_MISSING",
      },
    ]);
  });
});

describe("Mail per-conversation settlements", () => {
  test("settles confirmed conversations independently and restores the first failed command immediately", () => {
    const outcomes = createMailActionOutcomes();
    const settled: { conversationId: string; ok: boolean; expired: boolean }[] = [];
    const failed: string[] = [];
    outcomes.follow({
      actionId: "trash",
      destinationFolderId: "trash",
      onFailure: (id) => failed.push(id),
      onSettled: (result) => settled.push(result),
      conversations: [
        { conversationId: "one", label: "one", commands: [{ id: "a", state: "queued", sourceFolderId: "inbox" }] },
        {
          conversationId: "two",
          label: "two",
          commands: [
            { id: "b", state: "queued", sourceFolderId: "inbox" },
            { id: "c", state: "queued", sourceFolderId: "projects" },
          ],
        },
      ],
    });
    outcomes.apply(
      ["a", "b"],
      [
        { id: "a", state: "confirmed" },
        { id: "b", state: "failed" },
      ],
    );
    expect(settled).toEqual([{ conversationId: "one", ok: true, expired: false }]);
    expect(failed).toEqual(["two"]);
    expect(outcomes.apply(["c"], [{ id: "c", state: "confirmed" }])).toHaveLength(1);
    expect(settled).toEqual([
      { conversationId: "one", ok: true, expired: false },
      { conversationId: "two", ok: false, expired: false },
    ]);
    expect(failed).toEqual(["two"]);
  });
  test("follow reports immediate success and expiry releases pending conversations even when checked", () => {
    const outcomes = createMailActionOutcomes();
    const settled: boolean[] = [];
    outcomes.follow({
      actionId: "trash",
      destinationFolderId: null,
      now: 0,
      onSettled: (result) => settled.push(result.expired),
      conversations: [
        { conversationId: "one", label: "one", commands: [{ id: "a", state: "confirmed", sourceFolderId: "inbox" }] },
        { conversationId: "two", label: "two", commands: [{ id: "b", state: "queued", sourceFolderId: "inbox" }] },
      ],
    });
    expect(settled).toEqual([false]);
    outcomes.apply(["b"], [{ id: "b", state: "queued" }], 1);
    outcomes.apply([], [], MAIL_ACTION_OUTCOME_TTL_MS);
    expect(settled).toEqual([false, true]);
  });
  test("Undo stops only one conversation of one invocation, without a failure report or settlement", () => {
    const outcomes = createMailActionOutcomes();
    const key = Symbol();
    const settled: string[] = [];
    const conversation = (id: string) => ({
      conversationId: id,
      label: id,
      commands: [{ id, state: "queued" as const, sourceFolderId: "inbox" }],
    });
    outcomes.follow({
      key,
      actionId: "trash",
      destinationFolderId: null,
      onSettled: (result) => settled.push(result.conversationId),
      conversations: [conversation("a"), conversation("b")],
    });
    outcomes.follow({ key: Symbol(), actionId: "trash", destinationFolderId: null, conversations: [conversation("c")] });
    outcomes.stop(key, "a");
    expect(outcomes.pendingCommandIds()).toEqual(["b", "c"]);
    expect(outcomes.apply(["a"], [{ id: "a", state: "cancelled" }])).toEqual([]);
    expect(settled).toEqual([]);
    expect(
      outcomes.apply(
        ["b", "c"],
        [
          { id: "b", state: "confirmed" },
          { id: "c", state: "confirmed" },
        ],
      ),
    ).toEqual([]);
    expect(settled).toEqual(["b"]);
  });
});
