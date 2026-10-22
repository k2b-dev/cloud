import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { audit, SettingUnreadableError, settings } from "@k2b/cloud/services";
import * as settingsCache from "@k2b/cloud/services/settings";
import { SQL, sql } from "bun";
import { testActor, testCall } from "../../test/files-call";
import { app } from "../config";
import { readConfiguration, resetConfiguration, writeConfiguration } from "./configuration";

function storedString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a serialized configuration");
  return value;
}

const call = testCall(testActor);
const tx = Object.assign(new SQL("postgres://localhost/unused_test"), {
  savepoint: () => {
    throw new Error("Unexpected savepoint");
  },
});
let committed = false;
beforeEach(() => {
  committed = false;
  spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    await run(tx);
    committed = true;
  });
  spyOn(audit, "record").mockResolvedValue();
  spyOn(settingsCache, "invalidateSettingsCache").mockImplementation(async (keys) => {
    expect(committed).toBe(true);
    expect(keys).toEqual(["filesv2.configuration"]);
  });
});
afterEach(() => mock.restore());
afterAll(() => tx.close());

const area = { enabled: false, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
const input = {
  activityRetentionDays: 365,
  url: "http://filegate.test",
  cloud: { ...area, autoCreate: false, autoArchive: true },
  freeipa: { ...area, root: "freeipa" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
};

test("unreadable configuration exposes disabled defaults and refuses a merge without writing", async () => {
  spyOn(app.settings, "read").mockResolvedValue({ stored: "unreadable", value: "" });
  const write = spyOn(settings, "set").mockResolvedValue();
  expect(await readConfiguration()).toMatchObject({
    unreadable: true,
    token: "",
    tokenConfigured: false,
    cloud: { enabled: false },
    freeipa: { enabled: false },
  });
  await expect(writeConfiguration(input, call)).rejects.toMatchObject({ code: "configuration_unreadable", status: 409 });
  expect(write).not.toHaveBeenCalled();
});

test("a new token is a complete explicit replacement and needs no read", async () => {
  const read = spyOn(app.settings, "read").mockRejectedValue(new Error("Must not read before replacement"));
  const write = spyOn(settings, "set").mockResolvedValue();
  await writeConfiguration({ ...input, token: "new-token" }, call);
  expect(read).not.toHaveBeenCalled();
  expect(write.mock.calls).toEqual([
    ["filesv2.configuration", JSON.stringify({ ...input, token: "new-token" }), tx, { replaceUnreadable: true }],
  ]);
});

test("token retention uses the safe default and maps a concurrent unreadable row to Files 409", async () => {
  spyOn(app.settings, "read").mockResolvedValue({ stored: "readable", value: JSON.stringify({ ...input, token: "saved-token" }) });
  const write = spyOn(settings, "set").mockRejectedValue(new SettingUnreadableError("filesv2.configuration"));
  await expect(writeConfiguration(input, call)).rejects.toMatchObject({ code: "configuration_unreadable", status: 409 });
  expect(write.mock.calls[0]?.[3]).toBeUndefined();
  expect(JSON.parse(storedString(write.mock.calls[0]![1])).token).toBe("saved-token");
});

test("reset deletes the override without reading it", async () => {
  const read = spyOn(app.settings, "read").mockRejectedValue(new Error("Must not read"));
  const remove = spyOn(settings, "remove").mockResolvedValue();
  await resetConfiguration(call);
  expect(remove).toHaveBeenCalledWith("filesv2.configuration", tx);
  expect(read).not.toHaveBeenCalled();
});

test("older stored configuration reads with 365 days of history retention", async () => {
  const { activityRetentionDays: _retention, ...older } = input;
  spyOn(app.settings, "read").mockResolvedValue({ stored: "readable", value: JSON.stringify({ ...older, token: "saved-token" }) });
  expect((await readConfiguration()).activityRetentionDays).toBe(365);
});
test("history retention round-trips through configuration serialization", async () => {
  const write = spyOn(settings, "set").mockResolvedValue();
  await writeConfiguration({ ...input, token: "replacement", activityRetentionDays: 730 }, call);
  const stored = storedString(write.mock.calls[0]![1]);
  spyOn(app.settings, "read").mockResolvedValue({ stored: "readable", value: stored });
  expect((await readConfiguration()).activityRetentionDays).toBe(730);
});
test.each([29, 3651, 30.5])("history retention rejects %s days before saving", async (days) => {
  const write = spyOn(settings, "set").mockResolvedValue();
  await expect(writeConfiguration({ ...input, token: "replacement", activityRetentionDays: days }, call)).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});
test.each([30, 3650])("history retention accepts boundary %s", async (days) => {
  const write = spyOn(settings, "set").mockResolvedValue();
  await writeConfiguration({ ...input, token: "replacement", activityRetentionDays: days }, call);
  expect(JSON.parse(storedString(write.mock.calls[0]![1])).activityRetentionDays).toBe(days);
});

for (const action of ["update", "reset"] as const) {
  test(`${action} uses the settings transaction for audit and invalidates only after commit`, async () => {
    const write = spyOn(settings, "set").mockResolvedValue();
    const remove = spyOn(settings, "remove").mockResolvedValue();
    const record = spyOn(audit, "record").mockImplementation(async (_event, db) => {
      expect(db).toBe(tx);
      expect(committed).toBe(false);
      expect(settingsCache.invalidateSettingsCache).not.toHaveBeenCalled();
      expect(action === "update" ? write : remove).toHaveBeenCalledTimes(1);
    });
    if (action === "update") await writeConfiguration({ ...input, token: "new-token" }, call);
    else await resetConfiguration(call);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      {
        action: `filesv2.configuration.${action}`,
        outcome: "allowed",
        actor: { userId: testActor.kind === "user" ? testActor.user.id : undefined },
        target: { type: "filesv2.configuration", id: "filesv2.configuration" },
        requestId: call.requestId,
        metadata: { via: call.via, calling_app: call.callingApp, origin: call.origin, invocation_id: call.invocationId },
      },
      tx,
    );
    expect(settingsCache.invalidateSettingsCache).toHaveBeenCalledTimes(1);
  });
  test(`${action} does not invalidate when the audit fails`, async () => {
    spyOn(settings, "set").mockResolvedValue();
    spyOn(settings, "remove").mockResolvedValue();
    spyOn(audit, "record").mockRejectedValue(new Error("Audit unavailable"));
    const saving = action === "update" ? writeConfiguration({ ...input, token: "new-token" }, call) : resetConfiguration(call);
    await expect(saving).rejects.toThrow("Audit unavailable");
    expect(committed).toBe(false);
    expect(settingsCache.invalidateSettingsCache).not.toHaveBeenCalled();
  });
  test(`${action} propagates invalidation failure after commit`, async () => {
    spyOn(settings, "set").mockResolvedValue();
    spyOn(settings, "remove").mockResolvedValue();
    spyOn(settingsCache, "invalidateSettingsCache").mockRejectedValue(new Error("Cache unavailable"));
    const saving = action === "update" ? writeConfiguration({ ...input, token: "new-token" }, call) : resetConfiguration(call);
    await expect(saving).rejects.toThrow("Cache unavailable");
    expect(committed).toBe(true);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
}
