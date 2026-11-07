import { describe, expect, test } from "bun:test";
import {
  ACCESS_RESOURCE_TYPES,
  accessPermissionsForResource,
  accessResourcePath,
  assertAccessPermission,
  assertAccessPrincipal,
} from "./access-support";

describe("Grids CLI access resources", () => {
  test("exposes only Base and Grids App access", () => {
    expect(ACCESS_RESOURCE_TYPES).toEqual(["base", "app"]);
    expect(accessPermissionsForResource("base")).toEqual(["read", "write", "admin", "none"]);
    expect(accessPermissionsForResource("app")).toEqual(["read", "none"]);
  });

  test("uses the matching Base and Grids App API paths", () => {
    expect(accessResourcePath({ type: "base", id: "base-id", label: "Base", allowed: ["read"] })).toBe("/access/by-base/base-id");
    expect(accessResourcePath({ type: "app", id: "app/id", label: "App", allowed: ["read"] })).toBe("/access/by-custom-app/app%2Fid");
  });

  test("rejects permission levels outside the selected resource contract", () => {
    expect(() => assertAccessPermission({ type: "app", id: "app-id", label: "App", allowed: ["read", "none"] }, "write")).toThrow(
      "app grants only accept: read, none",
    );
  });

  test("allows public access only for Grids Apps", () => {
    expect(() => assertAccessPrincipal({ type: "base", id: "base-id", label: "Base", allowed: ["read"] }, { type: "public" })).toThrow(
      "Public access is only supported for Grids Apps",
    );
    expect(() => assertAccessPrincipal({ type: "app", id: "app-id", label: "App", allowed: ["read"] }, { type: "public" })).not.toThrow();
  });

  test("allows service accounts for Base and App grants", () => {
    const principal = { type: "service_account" as const, serviceAccountId: "service-account-id" };
    expect(() => assertAccessPrincipal({ type: "base", id: "base-id", label: "Base", allowed: ["read"] }, principal)).not.toThrow();
    expect(() => assertAccessPrincipal({ type: "app", id: "app-id", label: "App", allowed: ["read"] }, principal)).not.toThrow();
  });
});
