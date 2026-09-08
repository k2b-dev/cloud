import { describe, expect, test } from "bun:test";
import { DEFAULT_LINUX_IDENTITY_CONFIGURATION, isPosixName, LinuxIdentityConfigurationSchema, PosixOverridesSchema } from "./posix";

describe("Linux identity input contracts", () => {
  test("starts disabled without guessing an available numeric range", () => {
    expect(LinuxIdentityConfigurationSchema.parse(DEFAULT_LINUX_IDENTITY_CONFIGURATION).enabled).toBe(false);
    expect(LinuxIdentityConfigurationSchema.safeParse({ ...DEFAULT_LINUX_IDENTITY_CONFIGURATION, enabled: true }).success).toBe(false);
  });
  test("rejects passwd field injection, relative paths and unknown placeholders", () => {
    for (const homeDirectory of [
      "/",
      "home/alice",
      "/home/../root",
      "/home//alice",
      "/home/alice\nroot:x:0:0",
      "/home/alice:admin",
      "/home/al ice",
    ]) {
      expect(PosixOverridesSchema.safeParse({ homeDirectory, loginShell: "/bin/bash" }).success).toBe(false);
    }
    expect(
      LinuxIdentityConfigurationSchema.safeParse({ ...DEFAULT_LINUX_IDENTITY_CONFIGURATION, homeTemplate: "/home/{username}/{other}" })
        .success,
    ).toBe(false);
  });
  test("limits local Linux names without silently changing existing account names", () => {
    expect(isPosixName("alice-smith_2")).toBe(true);
    for (const name of ["Alice", "alice@example.org", "123", "a".repeat(33), "root\n"]) expect(isPosixName(name)).toBe(false);
  });
});
