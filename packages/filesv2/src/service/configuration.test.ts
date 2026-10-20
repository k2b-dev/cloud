import { afterEach, expect, spyOn, test } from "bun:test";
import { SettingUnreadableError } from "@k2b/cloud/services";
import { app } from "../config";
import { readConfiguration, resetConfiguration, writeConfiguration } from "./configuration";

const area = { enabled: false, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
const input = {
  activityRetentionDays: 365,
  url: "http://filegate.test",
  cloud: { ...area, autoCreate: false, autoArchive: true },
  freeipa: { ...area, root: "freeipa" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
};
afterEach(() => {
  spyOn(app.settings, "read").mockRestore();
  spyOn(app.settings, "set").mockRestore();
  spyOn(app.settings, "remove").mockRestore();
});

test("unreadable configuration exposes disabled defaults and refuses a merge without writing", async () => {
  spyOn(app.settings, "read").mockResolvedValue({ stored: "unreadable", value: "" });
  const write = spyOn(app.settings, "set").mockResolvedValue();
  expect(await readConfiguration()).toMatchObject({
    unreadable: true,
    token: "",
    tokenConfigured: false,
    cloud: { enabled: false },
    freeipa: { enabled: false },
  });
  await expect(writeConfiguration(input)).rejects.toMatchObject({ code: "configuration_unreadable", status: 409 });
  expect(write).not.toHaveBeenCalled();
});

test("a new token is a complete explicit replacement and needs no read", async () => {
  const read = spyOn(app.settings, "read").mockRejectedValue(new Error("Must not read before replacement"));
  const write = spyOn(app.settings, "set").mockResolvedValue();
  await writeConfiguration({ ...input, token: "new-token" });
  expect(read).not.toHaveBeenCalled();
  expect(write.mock.calls).toEqual([
    ["filesv2.configuration", JSON.stringify({ ...input, token: "new-token" }), { replaceUnreadable: true }],
  ]);
});

test("token retention uses the safe default and maps a concurrent unreadable row to Files 409", async () => {
  spyOn(app.settings, "read").mockResolvedValue({ stored: "readable", value: JSON.stringify({ ...input, token: "saved-token" }) });
  const write = spyOn(app.settings, "set").mockRejectedValue(new SettingUnreadableError("filesv2.configuration"));
  await expect(writeConfiguration(input)).rejects.toMatchObject({ code: "configuration_unreadable", status: 409 });
  expect(write.mock.calls[0]?.[2]).toBeUndefined();
  expect(JSON.parse(write.mock.calls[0]![1]).token).toBe("saved-token");
});

test("reset deletes the override without reading it", async () => {
  const read = spyOn(app.settings, "read").mockRejectedValue(new Error("Must not read"));
  const remove = spyOn(app.settings, "remove").mockResolvedValue();
  await resetConfiguration();
  expect(remove).toHaveBeenCalledWith("filesv2.configuration");
  expect(read).not.toHaveBeenCalled();
});

test("older stored configuration reads with 365 days of history retention", async () => {
  const { activityRetentionDays: _retention, ...older } = input;
  spyOn(app.settings, "read").mockResolvedValue({ stored: "readable", value: JSON.stringify({ ...older, token: "saved-token" }) });
  expect((await readConfiguration()).activityRetentionDays).toBe(365);
});
test("history retention round-trips through encrypted settings storage", async () => {
  const write = spyOn(app.settings, "set").mockResolvedValue();
  await writeConfiguration({ ...input, token: "replacement", activityRetentionDays: 730 });
  const stored = write.mock.calls[0]![1];
  spyOn(app.settings, "read").mockResolvedValue({ stored: "readable", value: stored });
  expect((await readConfiguration()).activityRetentionDays).toBe(730);
});
test.each([29, 3651, 30.5])("history retention rejects %s days before saving", async (days) => {
  const write = spyOn(app.settings, "set").mockResolvedValue();
  await expect(writeConfiguration({ ...input, token: "replacement", activityRetentionDays: days })).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});
test.each([30, 3650])("history retention accepts boundary %s", async (days) => {
  const write = spyOn(app.settings, "set").mockResolvedValue();
  await writeConfiguration({ ...input, token: "replacement", activityRetentionDays: days });
  expect(JSON.parse(write.mock.calls[0]![1]).activityRetentionDays).toBe(days);
});
