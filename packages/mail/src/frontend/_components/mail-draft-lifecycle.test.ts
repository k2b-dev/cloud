import { describe, expect, test } from "bun:test";
import type { MailDraft } from "../../contracts";
import { isClosedMailDraft, reconcileMailDraftLifecycle } from "./mail-draft-lifecycle";

const draft = (state: MailDraft["state"]): MailDraft =>
  ({
    state,
    lastEditedByDisplayName: "Ada Lovelace",
  }) as MailDraft;

describe("mail draft lifecycle", () => {
  test("keeps only editable drafts open", () => {
    expect(isClosedMailDraft(draft("draft"))).toBeFalse();
    for (const state of ["scheduled", "sending", "sent", "discarded"] as const) {
      expect(isClosedMailDraft(draft(state))).toBeTrue();
    }
  });

  test("advances from scheduled to sent without losing the local-change warning", () => {
    const scheduled = reconcileMailDraftLifecycle(null, draft("scheduled"), true);
    const sent = reconcileMailDraftLifecycle(scheduled, draft("sent"), false);
    expect(sent?.draft.state).toBe("sent");
    expect(sent?.hasUnsavedChanges).toBeTrue();
  });
});
