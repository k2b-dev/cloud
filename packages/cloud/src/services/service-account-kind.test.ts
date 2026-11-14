import { expect, test } from "bun:test";
import { ServiceAccountKindSchema } from "../contracts/shared";
import { serviceAccountMayHoldCredentials, serviceAccountUsesOwnGrants } from "./service-accounts";

for (const [kind, ownGrants, credentials] of [
  ["user_delegated", false, true],
  ["resource_bound", false, true],
  ["standalone", true, true],
  ["agent", true, true],
  ["code", true, false],
] as const) {
  test(`${kind}: grant resolution and credential eligibility are independent`, () => {
    expect(ServiceAccountKindSchema.parse(kind)).toBe(kind);
    expect(serviceAccountUsesOwnGrants(kind)).toBe(ownGrants);
    expect(serviceAccountMayHoldCredentials(kind)).toBe(credentials);
  });
}
test("unknown account kinds cannot acquire credentials", () => {
  expect(serviceAccountMayHoldCredentials("unknown")).toBe(false);
});
