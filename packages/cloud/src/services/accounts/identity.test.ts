import { expect, test } from "bun:test";
import { EMERGENCY_ADMIN_UID } from "../providers/local/constants";
import { isEmergencyIdentity } from "./identity";

test.each([
  { uid: EMERGENCY_ADMIN_UID, provider: "local", emergency_admin: true, expected: true },
  { uid: EMERGENCY_ADMIN_UID, provider: "local", emergency_admin: false, expected: false },
  { uid: EMERGENCY_ADMIN_UID, provider: "ipa", emergency_admin: true, expected: false },
  { uid: EMERGENCY_ADMIN_UID, provider: "ipa", emergency_admin: false, expected: false },
  { uid: "ordinary-admin", provider: "local", emergency_admin: true, expected: false },
  { uid: "ordinary-admin", provider: "local", emergency_admin: false, expected: false },
  { uid: "ordinary-admin", provider: "ipa", emergency_admin: true, expected: false },
  { uid: "ordinary-admin", provider: "ipa", emergency_admin: false, expected: false },
] as const)("emergency detection: $provider/$uid with marker $emergency_admin is $expected", ({ expected, ...row }) => {
  expect(isEmergencyIdentity(row)).toBe(expected);
});
