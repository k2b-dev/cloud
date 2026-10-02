import { describe, expect, test } from "bun:test";
import { createMailActionOutcomes, MAIL_ACTION_OUTCOME_TTL_MS } from "./mail-action-outcomes";

describe("Mail action outcomes", () => {
  const archiveTwo = (outcomes: ReturnType<typeof createMailActionOutcomes>, now = Date.now()) =>
    outcomes.follow({
      actionId: "archive",
      destinationFolderId: null,
      conversations: [
        { conversationId: "c1", label: "Quarterly report", commands: [{ id: "m1", state: "queued" }] },
        {
          conversationId: "c2",
          label: "Team lunch",
          commands: [
            { id: "m2", state: "queued" },
            { id: "m3", state: "queued" },
          ],
        },
      ],
      now,
    });

  test("reports a queued archive that fails later, once every command finished", () => {
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

    expect(outcomes.apply(["m3"], [{ id: "m3", state: "confirmed", code: null }])).toEqual([
      {
        actionId: "archive",
        destinationFolderId: null,
        conversationCount: 2,
        failures: [{ conversationId: "c2", label: "Team lunch", code: "REMOTE_MESSAGE_MISSING" }],
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
    expect(report?.failures).toEqual([{ conversationId: "c2", label: "Team lunch", code: "needs_attention" }]);
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
      conversations: [{ conversationId: "c1", label: "Quarterly report", commands: [{ id: "m1", state: "failed", code: null }] }],
    });
    expect(report?.failures).toEqual([{ conversationId: "c1", label: "Quarterly report", code: "failed" }]);
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
    expect(outcomes.apply(["m1", "m2"], [{ id: "m2", state: "failed", code: "PROVIDER_RIGHTS_CHANGED" }], 1)).toEqual([]);
    // Failed requests apply nothing, but the lifetime still runs out.
    expect(outcomes.apply([], [], MAIL_ACTION_OUTCOME_TTL_MS - 1)).toEqual([]);
    expect(outcomes.hasPending()).toBe(true);
    expect(outcomes.apply([], [], MAIL_ACTION_OUTCOME_TTL_MS)).toEqual([
      {
        actionId: "archive",
        destinationFolderId: null,
        conversationCount: 2,
        failures: [{ conversationId: "c2", label: "Team lunch", code: "PROVIDER_RIGHTS_CHANGED" }],
      },
    ]);
    expect(outcomes.hasPending()).toBe(false);
  });
});
