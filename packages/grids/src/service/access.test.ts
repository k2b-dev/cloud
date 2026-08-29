import { describe, expect, test } from "bun:test";
import { type AccessBinding, buildAccessAuditDiff, validateAccessPrincipal } from "./access";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCESS_ID = "22222222-2222-4222-8222-222222222222";

describe("access audit diff", () => {
  test("captures a new Grids App grant with stable resource and principal data", () => {
    const binding: AccessBinding = {
      resourceType: "customApp",
      baseId: "33333333-3333-4333-8333-333333333333",
      customAppId: "44444444-4444-4444-8444-444444444444",
    };

    expect(
      buildAccessAuditDiff(
        "access.granted",
        binding,
        {
          id: ACCESS_ID,
          user_id: USER_ID,
          group_id: null,
          service_account_id: null,
          authenticated_only: false,
          permission: "read",
        },
        "read",
      ),
    ).toEqual({
      access: {
        old: null,
        new: {
          id: ACCESS_ID,
          resourceType: "customApp",
          resourceId: "44444444-4444-4444-8444-444444444444",
          principal: { type: "user", userId: USER_ID },
          permission: "read",
        },
      },
    });
  });

  test("captures permission changes without changing the principal", () => {
    const binding: AccessBinding = {
      resourceType: "base",
      baseId: "33333333-3333-4333-8333-333333333333",
    };

    expect(
      buildAccessAuditDiff(
        "access.updated",
        binding,
        {
          id: ACCESS_ID,
          user_id: null,
          group_id: null,
          service_account_id: null,
          authenticated_only: true,
          permission: "write",
        },
        "none",
      ),
    ).toEqual({
      access: {
        old: {
          id: ACCESS_ID,
          resourceType: "base",
          resourceId: "33333333-3333-4333-8333-333333333333",
          principal: { type: "authenticated" },
          permission: "write",
        },
        new: {
          id: ACCESS_ID,
          resourceType: "base",
          resourceId: "33333333-3333-4333-8333-333333333333",
          principal: { type: "authenticated" },
          permission: "none",
        },
      },
    });
  });

  test("captures revoked group access with a null new value", () => {
    const binding: AccessBinding = {
      resourceType: "base",
      baseId: "33333333-3333-4333-8333-333333333333",
    };

    expect(
      buildAccessAuditDiff(
        "access.revoked",
        binding,
        {
          id: ACCESS_ID,
          user_id: null,
          group_id: "66666666-6666-4666-8666-666666666666",
          service_account_id: null,
          authenticated_only: false,
          permission: "admin",
        },
        null,
      ),
    ).toEqual({
      access: {
        old: {
          id: ACCESS_ID,
          resourceType: "base",
          resourceId: "33333333-3333-4333-8333-333333333333",
          principal: { type: "group", groupId: "66666666-6666-4666-8666-666666666666" },
          permission: "admin",
        },
        new: null,
      },
    });
  });
});

test("validates principals per resource boundary", () => {
  expect(validateAccessPrincipal("base", { type: "public" })).toBe("Public access is only supported for Grids Apps.");
  expect(validateAccessPrincipal("customApp", { type: "public" })).toBeNull();
  expect(validateAccessPrincipal("base", { type: "service_account", serviceAccountId: ACCESS_ID })).toBeNull();
  expect(validateAccessPrincipal("customApp", { type: "service_account", serviceAccountId: ACCESS_ID })).toBe(
    "Grids App access does not support service accounts. Grant access to the delegated user instead.",
  );
});
