import { describe, expect, test } from "bun:test";
import { profilePreferencesMessages } from "./profile-preferences-messages";

describe("profile preferences messages", () => {
  test("ships complete English and German menu copy with regional fallback", () => {
    expect(profilePreferencesMessages.check()).toEqual([]);
    expect(profilePreferencesMessages.resolve(["en-GB"]).t.profileSettings).toBe("Profile settings");
    expect(profilePreferencesMessages.resolve(["de-CH"]).t.profileSettings).toBe("Profileinstellungen");
  });
});
