import { describe, expect, mock, test } from "bun:test";
import { resolvePackedConsumerPins } from "./packed-consumer-pins";

const fixture = {
  pins: { "@k2b/ui": "0.25.0", "@k2b/ssr": "0.16.0" },
  workspaceVersions: { "@k2b/ui": "0.26.0", "@k2b/ssr": "0.16.0" },
  archives: { "@k2b/ui": "/tmp/ui.tgz", "@k2b/ssr": "/tmp/ssr.tgz" },
};

describe("packed consumer sibling pins", () => {
  test("normal PRs use workspace tarballs without consulting npm, even when pins differ", async () => {
    const isPublished = mock(async () => true);
    const result = await resolvePackedConsumerPins({ ...fixture, mode: "workspace", isPublished });
    expect(result).toEqual({
      "@k2b/ui": { pin: "0.25.0", spec: "/tmp/ui.tgz", source: "packed" },
      "@k2b/ssr": { pin: "0.16.0", spec: "/tmp/ssr.tgz", source: "packed" },
    });
    expect(isPublished).not.toHaveBeenCalled();
  });

  test("a release uses the published pin over a newer workspace copy (#1221)", async () => {
    const isPublished = mock(async (name: string, version: string) => name === "@k2b/ui" && version === "0.25.0");
    const result = await resolvePackedConsumerPins({ ...fixture, mode: "release", isPublished });
    expect(result).toEqual({
      "@k2b/ui": { pin: "0.25.0", spec: "0.25.0", source: "npm" },
      "@k2b/ssr": { pin: "0.16.0", spec: "/tmp/ssr.tgz", source: "packed" },
    });
    expect(isPublished.mock.calls).toEqual([
      ["@k2b/ui", "0.25.0"],
      ["@k2b/ssr", "0.16.0"],
    ]);
  });

  test("already published versions win even when they equal the workspace versions", async () => {
    const result = await resolvePackedConsumerPins({ ...fixture, mode: "release", isPublished: async () => true });
    expect(result["@k2b/ssr"]).toEqual({ pin: "0.16.0", spec: "0.16.0", source: "npm" });
  });

  test("unpublished pins matching this release use their tarballs", async () => {
    const result = await resolvePackedConsumerPins({
      ...fixture,
      pins: fixture.workspaceVersions,
      mode: "release",
      isPublished: async () => false,
    });
    expect(result["@k2b/ui"].spec).toBe("/tmp/ui.tgz");
    expect(result["@k2b/ssr"].spec).toBe("/tmp/ssr.tgz");
    expect(Object.values(result).every((pin) => pin.source === "packed")).toBe(true);
  });

  for (const name of ["@k2b/ui", "@k2b/ssr"] as const) {
    test(`rejects an unpublished ${name} pin that this release does not publish`, async () => {
      await expect(
        resolvePackedConsumerPins({
          ...fixture,
          pins: { ...fixture.workspaceVersions, [name]: "0.1.0" },
          mode: "release",
          isPublished: async () => false,
        }),
      ).rejects.toThrow(
        `${name}@0.1.0 is neither on npm nor published by this release (workspace version: ${fixture.workspaceVersions[name]})`,
      );
    });
  }

  test("registry failures propagate instead of falling back to the workspace", async () => {
    await expect(
      resolvePackedConsumerPins({
        ...fixture,
        pins: fixture.workspaceVersions,
        mode: "release",
        isPublished: async () => {
          throw new Error("registry unavailable");
        },
      }),
    ).rejects.toThrow("registry unavailable");
  });
});
