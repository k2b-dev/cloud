import { expect, test } from "bun:test";
import { ordinaryAccountIdentity } from "./identity";

test.each([
  { provider: "ipa", profile: "user" },
  { provider: "ipa", profile: "guest" },
  { provider: "local", profile: "user" },
  { provider: "local", profile: "guest" },
] as const)("an ordinary $provider/$profile transition ends the emergency marker", (identity) => {
  const previous = { uid: "admin", provider: "local", profile: "user", emergency_admin: true };
  expect({ ...previous, ...ordinaryAccountIdentity(identity) }).toEqual({ ...previous, ...identity, emergency_admin: false });
});

test("a directory rename updates the UID and ends the emergency marker together", () => {
  const previous = { uid: "admin", provider: "local", profile: "user", emergency_admin: true };
  expect({ ...previous, ...ordinaryAccountIdentity({ provider: "ipa", profile: "user", uid: "ada" }) }).toEqual({
    uid: "ada",
    provider: "ipa",
    profile: "user",
    emergency_admin: false,
  });
});
