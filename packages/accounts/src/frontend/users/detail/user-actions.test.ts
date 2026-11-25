import { describe, expect, test } from "bun:test";
import type { LocalUser, User } from "@k2b/cloud/contracts";
import { emailRules, userActionAvailability } from "./user-actions";
import { dayFromText } from "./user-dialogs";
import { toSafeParagraphHtml } from "./user-requests";
import { userRecordHref, userTabFrom } from "./user-view";

const user = (mail: string | null, overrides: Partial<Omit<LocalUser, "provider" | "ipa">> = {}): LocalUser => ({
  id: "local-id",
  uid: "ada",
  provider: "local",
  profile: "user",
  roles: ["user"],
  givenname: "Ada",
  sn: "Lovelace",
  displayName: "Ada Lovelace",
  mail,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ...overrides,
});

describe("the deeds a user's record offers", () => {
  test("accounts without email keep the login token and leave out email-only deeds", () => {
    const can = userActionAvailability(user(null), true);
    expect(can.loginToken).toBe(true);
    expect(can.notify).toBe(false);
    expect(can.createIpa).toBe(false);
  });
  test("accounts with email offer every deed", () => {
    const can = userActionAvailability(user("ada@example.com"), true);
    expect([can.loginToken, can.notify, can.createIpa, can.canMutate, can.setExpiry]).toEqual([true, true, true, true, true]);
  });
  test("the emergency admin account offers no login token", () => {
    expect(userActionAvailability(user(null, { uid: "admin", roles: ["user", "admin"] }), true).loginToken).toBe(false);
  });
  test("a FreeIPA account is changed only while FreeIPA is on, and never gets local profile or admin deeds", () => {
    const ipa: User = {
      ...user("ada@example.com"),
      provider: "ipa",
      ipa: {
        uidNumber: null,
        phone: null,
        employeeType: null,
        mobile: null,
        address: { street: null, postalCode: null, city: null, state: null },
        passwordExpires: null,
        lastLoginIpa: null,
        syncedAt: null,
        sshPublicKeys: [],
        sshFingerprints: [],
      },
    };
    expect(userActionAvailability(ipa, false)).toMatchObject({ canMutate: false, setExpiry: false, ipaDeeds: false, local: false });
    expect(userActionAvailability(ipa, true)).toMatchObject({ canMutate: true, ipaDeeds: true, loginToken: false });
  });
  test("the audit links name the account as actor and as target", () => {
    const can = userActionAvailability(user(null), false);
    expect(can.auditByUserHref).toBe("/app/accounts/audit?actor=local-id");
    expect(can.auditOnUserHref).toBe("/app/accounts/audit?target=local-id");
  });
});

describe("the email rules of the edit form", () => {
  test("an address that must stay is required, so the server never has to refuse its removal", () => {
    expect(emailRules(user("ada@example.com"), false)).toEqual({ removable: false, required: true });
    // a guest keeps a required address even while the installation allows accounts without one
    expect(emailRules(user("ada@example.com", { profile: "guest" }), true)).toEqual({ removable: false, required: true });
  });
  test("a full local account may lose its address where the installation allows it; the emergency admin always", () => {
    expect(emailRules(user("ada@example.com"), true)).toEqual({ removable: true, required: false });
    expect(emailRules(user("admin@example.com", { uid: "admin" }), false)).toEqual({ removable: true, required: false });
    // an account without an address has nothing to keep
    expect(emailRules(user(null), false).required).toBe(false);
  });
});

describe("the record's address and inputs", () => {
  test("the tab comes from the address; inherited memberships alone open the groups", () => {
    expect(userTabFrom(undefined, false)).toBe("overview");
    expect(userTabFrom("keys", false)).toBe("keys");
    expect(userTabFrom("bogus", false)).toBe("overview");
    expect(userTabFrom(undefined, true)).toBe("groups");
    expect(userRecordHref("u1", "status=active", { tab: "groups", recursive: true })).toBe(
      "/app/accounts/users/u1?list=status%3Dactive&tab=groups&recursive=true",
    );
    expect(userRecordHref("u1", "", { tab: "overview" })).toBe("/app/accounts/users/u1");
  });
  test("the expiry takes a real day, written either way", () => {
    expect(dayFromText("2026-12-31")).toBe("2026-12-31");
    expect(dayFromText(" 1.2.2027 ")).toBe("2027-02-01");
    expect(dayFromText("2026-02-30")).toBeNull();
    expect(dayFromText("morgen")).toBeNull();
  });
  test("a notification's text is sent as escaped paragraphs", () => {
    expect(toSafeParagraphHtml("Hallo <b>Ada</b>\n\n  & bis bald ")).toBe("<p>Hallo &lt;b&gt;Ada&lt;/b&gt;</p><p>&amp; bis bald</p>");
  });
});
