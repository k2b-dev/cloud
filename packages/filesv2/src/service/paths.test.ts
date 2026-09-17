import { describe, expect, test } from "bun:test";
import { relativePath, userPath, validateConfiguration } from "./paths";

const configuration = {
  url: "http://filegate:4000",
  cloud: {
    autoCreate: false,
    autoArchive: true,
    enabled: true,
    root: "cloud",
    prefix: "space",
    homes: "users",
    groups: "groups",
    archive: "archive",
  },
  freeipa: { enabled: false, root: "freeipa", prefix: "", homes: "homes", groups: "groups", archive: "archive" },
};
describe("Files path boundaries", () => {
  test("rejects traversal, absolute and private paths", () => {
    for (const value of ["../secret", "/etc/passwd", "a//b", "a/../b", "a\\b", "a/.filegate", "a\0b"])
      expect(() => relativePath(value)).toThrow();
    expect(relativePath("reports/2026.pdf")).toBe("reports/2026.pdf");
  });
  test("reserves only top-level trash", () => {
    expect(() => userPath("trash")).toThrow();
    expect(() => userPath("trash/old.pdf")).toThrow();
    expect(userPath("reports/trash")).toBe("reports/trash");
  });
  test("config paths and roots cannot overlap", () => {
    expect(() => validateConfiguration(configuration)).not.toThrow();
    expect(() => validateConfiguration({ ...configuration, cloud: { ...configuration.cloud, archive: "users/archive" } })).toThrow();
    expect(() =>
      validateConfiguration({ ...configuration, freeipa: { ...configuration.freeipa, enabled: true, root: "cloud" } }),
    ).toThrow();
    expect(() => validateConfiguration({ ...configuration, url: "http://token@filegate:4000" })).toThrow();
  });
});
