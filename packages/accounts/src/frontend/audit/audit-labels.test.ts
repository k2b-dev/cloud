import { describe, expect, test } from "bun:test";
import { accountsMessages } from "../messages";
import { actionLabel, actionOptions } from "./audit-labels";

describe("localized audit labels", () => {
  test("uses the German catalog for regional German locales", () => {
    const { t } = accountsMessages.resolve(["de-CH"]);

    expect(actionLabel("accounts.user.create", t)).toBe("Benutzer erstellen");
    expect(actionOptions(t).map((section) => section.label)).toEqual(["Benutzer", "Gruppen", "Anfragen", "Dienstkonten"]);
  });

  test("keeps unknown audit action codes unchanged", () => {
    const { t } = accountsMessages.resolve(["de"]);

    expect(actionLabel("external.provider.action", t)).toBe("external.provider.action");
  });
});
