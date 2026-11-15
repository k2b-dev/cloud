import { expect, test } from "bun:test";
import { EMERGENCY_ADMIN_UID } from "../providers/local/constants";
import { hasReservedEmergencyUid, isEmergencyIdentity } from "./identity";

test.each([
  { uid: EMERGENCY_ADMIN_UID, provider: "local", emergency_admin: true, expected: true, reserved: true },
  { uid: EMERGENCY_ADMIN_UID, provider: "local", emergency_admin: false, expected: false, reserved: true },
  { uid: EMERGENCY_ADMIN_UID, provider: "ipa", emergency_admin: true, expected: false, reserved: false },
  { uid: EMERGENCY_ADMIN_UID, provider: "ipa", emergency_admin: false, expected: false, reserved: false },
  { uid: "ordinary-admin", provider: "local", emergency_admin: true, expected: false, reserved: false },
  { uid: "ordinary-admin", provider: "local", emergency_admin: false, expected: false, reserved: false },
  { uid: "ordinary-admin", provider: "ipa", emergency_admin: true, expected: false, reserved: false },
  { uid: "ordinary-admin", provider: "ipa", emergency_admin: false, expected: false, reserved: false },
] as const)("emergency detection: $provider/$uid with marker $emergency_admin is $expected", ({ expected, reserved, ...row }) => {
  expect(isEmergencyIdentity(row)).toBe(expected);
  expect(hasReservedEmergencyUid(row)).toBe(reserved);
});
