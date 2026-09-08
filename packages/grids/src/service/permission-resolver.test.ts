import { describe, expect, test } from "bun:test";
import type { Grant } from "./permission-resolver";
import { hasAtLeast, minPermission, permissionFromCredentialScopes, resolveEffectivePermission } from "./permission-resolver";

const baseId = "11111111-1111-4111-8111-111111111111";
const customAppId = "22222222-2222-4222-8222-222222222222";
const grant = (input: Partial<Grant> & Pick<Grant, "resourceType" | "resourceId" | "level">): Grant => ({
  principalTier: "user",
  ...input,
});

describe("resolveEffectivePermission", () => {
  test("resolves an exact base without considering Grids App grants", () => {
    const grants: Grant[] = [
      grant({ resourceType: "base", resourceId: baseId, level: "write" }),
      grant({ resourceType: "customApp", resourceId: customAppId, level: "read" }),
    ];
    expect(resolveEffectivePermission(grants, { baseId })).toBe("write");
  });

  test("resolves an exact Grids App without falling back to its base", () => {
    const grants: Grant[] = [grant({ resourceType: "base", resourceId: baseId, level: "admin" })];
    expect(resolveEffectivePermission(grants, { customAppId })).toBe("none");
  });

  test("uses the first matching principal tier and deny wins inside that tier", () => {
    const grants: Grant[] = [
      grant({ resourceType: "base", resourceId: baseId, level: "read", principalTier: "user" }),
      grant({ resourceType: "base", resourceId: baseId, level: "none", principalTier: "user" }),
      grant({ resourceType: "base", resourceId: baseId, level: "admin", principalTier: "group" }),
    ];
    expect(resolveEffectivePermission(grants, { baseId })).toBe("none");
  });

  test("supports public Grids App grants", () => {
    const grants: Grant[] = [grant({ resourceType: "customApp", resourceId: customAppId, level: "read", principalTier: "public" })];
    expect(resolveEffectivePermission(grants, { customAppId })).toBe("read");
  });
});

test("hasAtLeast follows the Cloud permission order", () => {
  expect(hasAtLeast("admin", "write")).toBe(true);
  expect(hasAtLeast("read", "write")).toBe(false);
});

describe("credential permissions", () => {
  test("recognizes each Grids scope alias", () => {
    for (const scope of ["admin", "grids:admin", "grids:*"]) expect(permissionFromCredentialScopes([scope])).toBe("admin");
    for (const scope of ["write", "grids:write"]) expect(permissionFromCredentialScopes([scope])).toBe("write");
    for (const scope of ["read", "grids:read"]) expect(permissionFromCredentialScopes([scope])).toBe("read");
  });

  test("unknown, empty and other-app scopes grant no Grids permission", () => {
    for (const scopes of [[], ["mail:admin"], ["*"], ["grids"], ["grids:READ"], ["grids:read:records"]]) {
      expect(permissionFromCredentialScopes(scopes)).toBe("none");
    }
  });

  test("the strongest recognized scope wins regardless of order or unrelated scopes", () => {
    expect(permissionFromCredentialScopes(["grids:read", "mail:admin", "write"])).toBe("write");
    expect(permissionFromCredentialScopes(["grids:*", "write", "read"])).toBe("admin");
    expect(permissionFromCredentialScopes(["read", "write", "grids:admin"])).toBe("admin");
  });

  test("caps both operands at the lower permission for every level pair", () => {
    const levels = ["none", "read", "write", "admin"] as const;
    for (const [leftRank, left] of levels.entries()) {
      for (const [rightRank, right] of levels.entries()) {
        expect(minPermission(left, right)).toBe(leftRank <= rightRank ? left : right);
        expect(hasAtLeast(left, right)).toBe(leftRank >= rightRank);
      }
    }
  });
});
