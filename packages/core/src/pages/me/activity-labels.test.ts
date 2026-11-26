import { expect, test } from "bun:test";
import { audit } from "@k2b/cloud/services";
import { activityLabel, activityWords } from "./activity-labels";
import { accountMessages } from "./messages";

// The account's activity shows the audit log's self-service actions in Core's words. A new action in the audit service
// without words here would reach people as the service's English sentence.
test("every self-service action of the audit log has Core's words in every locale", () => {
  for (const locale of ["en", "de"] as const) {
    const words = activityWords(accountMessages.resolve([locale]).t);
    const missing = audit.selfServiceActions.filter((action) => !words[action]);
    expect(missing).toEqual([]);
  }
});

test("a refused attempt reads as a refusal, never as the deed it tried", () => {
  const { t } = accountMessages.resolve(["de"]);
  const entry = { id: 1, createdAt: "2026-09-30T10:00:00.000Z", label: "Passkey used", context: null };
  expect(activityLabel({ ...entry, action: "webauthn_credential.authenticate", outcome: "allowed" }, t)).toBe("Passkey verwendet");
  expect(activityLabel({ ...entry, action: "webauthn_credential.authenticate", outcome: "denied" }, t)).toBe(
    "Anmeldung mit Passkey abgelehnt",
  );
  expect(activityLabel({ ...entry, action: "accounts.user.update", outcome: "failed" }, t)).toBe("Profil aktualisiert (abgelehnt)");
});
