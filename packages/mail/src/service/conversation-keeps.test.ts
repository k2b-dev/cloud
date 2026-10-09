import { describe, expect, test } from "bun:test";
import { mutationFailureState } from "./command-runtime";
import { containsDeletedFlag, keepError, keepErrors } from "./conversation-keep-rules";
import { localizeMailError } from "./error-messages";
import { mailWorkflowActionFailure } from "./workflow-action-errors";

describe("conversation keep protections", () => {
  test("detects deletion in public and IMAP spelling, case insensitively", () => {
    for (const flag of ["\\Deleted", "\\DELETED", "\\deleted", "deleted", " Deleted "])
      expect(containsDeletedFlag(["\\Seen", flag])).toBeTrue();
    for (const flags of [[], ["seen", "flagged"], ["\\Seen", "\\Flagged"], ["not-deleted"], null, "\\Deleted"])
      expect(containsDeletedFlag(flags)).toBeFalse();
  });
  test("preserves stable conflicts in localized errors and workflow failures", () => {
    const german = {
      CONVERSATION_KEPT:
        "Diese Unterhaltung wird aufbewahrt und kann nicht gelöscht oder in den Papierkorb oder Spam verschoben werden. Verschieben und Archivieren sind weiterhin möglich.",
      FOLDER_HAS_KEPT_CONVERSATIONS:
        "Dieser Ordner enthält aufbewahrte Unterhaltungen und kann nicht gelöscht werden. Verschiebe sie zuerst in einen anderen Ordner.",
      KEPT_COPY_ONLY:
        "Von diesen Nachrichten ist nur noch die in Cloud aufbewahrte Kopie vorhanden. Sie können auf dem Mailserver nicht geändert werden.",
    };
    for (const code of Object.keys(keepErrors) as Array<keyof typeof keepErrors>) {
      const error = keepError(code);
      expect(localizeMailError(error, "en")).toEqual(error);
      expect(localizeMailError(error, "de-CH")).toEqual({ ...error, message: german[code] });
      expect(mailWorkflowActionFailure(error)).toEqual({ state: "failed", code, message: error.message, retryable: false });
      expect(mutationFailureState(Object.assign(new Error(error.message), error), false)).toBe("failed");
    }
  });
});
