import { describe, expect, test } from "bun:test";
import { accountsMessages } from "../messages";
import { actionLabel, actionOptions } from "./audit-labels";

describe("localized audit labels", () => {
  test("uses the German catalog for regional German locales", () => {
    const { t } = accountsMessages.resolve(["de-CH"]);

    expect(actionLabel("accounts.user.create", t)).toBe("Benutzer erstellen");
    expect(actionOptions(t).map((section) => section.label)).toEqual([
      "Benutzer",
      "Gruppen",
      "Anfragen",
      "Dienstkonten",
      "Assistant-Freigaben",
    ]);
  });

  test.each([
    ["en", "Assistant approvals", "Remember Assistant approval", "Revoke Assistant approval", "Remembered approval"],
    ["de", "Assistant-Freigaben", "Assistant-Freigabe merken", "Assistant-Freigabe entziehen", "Gemerkte Freigabe"],
  ])("labels remembered approvals in %s", (locale, section, remember, revoke, target) => {
    const { t } = accountsMessages.resolve([locale]);
    expect(actionLabel("ai.approval.remember", t)).toBe(remember);
    expect(actionLabel("ai.approval.revoke", t)).toBe(revoke);
    expect(t.approvalTarget).toBe(target);
    const sections = actionOptions(t);
    expect(sections.at(-2)?.options.map((option) => option.value)).toEqual([
      "service_account_credential.create",
      "service_account_credential.revoke",
      "service_account_credential.authenticate",
    ]);
    expect(sections.at(-1)).toEqual({
      label: section,
      options: [
        { value: "ai.approval.remember", label: remember, icon: "ti ti-checks" },
        { value: "ai.approval.revoke", label: revoke, icon: "ti ti-circle-x" },
      ],
    });
  });

  test("keeps unknown audit action codes unchanged", () => {
    const { t } = accountsMessages.resolve(["de"]);

    expect(actionLabel("external.provider.action", t)).toBe("external.provider.action");
  });
});
