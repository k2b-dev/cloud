import { expect, test } from "bun:test";
import { formatLogTitle } from "./mail-automation-log-format";
import { mailAutomationLogMessages } from "./mail-automation-log-messages";

for (const locale of ["en", "de"] as const) {
  test(`an occupied reply box names the skipped draft rather than an assignment (${locale})`, () => {
    const { t } = mailAutomationLogMessages.resolve([locale]);
    expect(formatLogTitle({ outcome: "skipped", effects: [], reasons: [{ kind: "reply_draft_occupied" }] }, t)).toBe(
      locale === "en" ? "Reply draft skipped" : "Antwortentwurf übersprungen",
    );
    expect(formatLogTitle({ outcome: "skipped", effects: [], reasons: [{ kind: "already_assigned" }] }, t)).toBe(t.skippedAssign);
    expect(t.traceReplyDraftSkipped({ rule: "Review" })).toContain(locale === "en" ? "reply draft" : "Antwortentwurf");
  });
}
