import { describe, expect, test } from "bun:test";
import { IPA_ACTIVE_CONFLICT, IPA_IDENTITY_CONFLICT, ipaEntryId, reactivationConflict } from "./reactivation";

const now = new Date("2026-11-05T12:00:00Z");
const entry = {
  uid: ["ada"],
  mail: [" Ada@Example.test "],
  ipauniqueid: ["entry-1"],
  uidnumber: ["12345"],
  krbprincipalexpiration: ["20260101000000Z"],
};
const input = { entry, uid: "ada", mail: "ada@example.test", uidNumber: 12345, directoryUrl: "ipa.example.test", now };
const retry = { uid: input.uid, mail: input.mail, directory_url: input.directoryUrl, remote_id: "ipauniqueid:entry-1" };

describe("FreeIPA reactivation identity boundary", () => {
  test("accepts expired or disabled entries with matching UID and normalized mail", () => {
    expect(reactivationConflict(input)).toBeNull();
    expect(reactivationConflict({ ...input, entry: { ...entry, krbprincipalexpiration: [], nsaccountlock: [true] } })).toBeNull();
    expect(ipaEntryId({ ipauniqueid: ["strong"], nsuniqueid: ["other"] })).toBe("ipauniqueid:strong");
    expect(ipaEntryId({ nsuniqueid: ["ldap"] })).toBe("nsuniqueid:ldap");
  });
  test.each([
    { mail: ["other@example.test"] },
    { mail: [] },
    { uid: ["other"] },
    { ipauniqueid: [] },
    { uidnumber: ["54321"] },
    { krbprincipalexpiration: ["malformed"] },
  ])("fails closed on different or missing identity / invalid expiry: %j", (change) => {
    expect(reactivationConflict({ ...input, entry: { ...entry, ...change } })).not.toBeNull();
  });
  test("only the durable matching entry claim allows a retry of an active account", () => {
    const active = { ...input, entry: { ...entry, krbprincipalexpiration: [] } };
    expect(reactivationConflict(active)).toBe(IPA_ACTIVE_CONFLICT);
    expect(reactivationConflict({ ...active, retry })).toBeNull();
    expect(reactivationConflict({ ...active, retry: { ...retry, remote_id: "ipauniqueid:replacement" } })).toBe(IPA_IDENTITY_CONFLICT);
    expect(reactivationConflict({ ...active, retry: { ...retry, directory_url: "other.example.test" } })).toBe(IPA_IDENTITY_CONFLICT);
  });
});
