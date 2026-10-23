import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as settings from "@k2b/cloud/services/settings";
import { SQL, sql } from "bun";
import { app } from "../config";
import { storageSettings } from "./storage-settings";
import { testIdentity } from "./test-identity";

const tx = Object.assign(new SQL("postgres://localhost/unused_test"), {
  savepoint: () => {
    throw new Error("Unexpected savepoint");
  },
});
afterAll(async () => {
  await tx.close();
});
let restoreTransaction: () => void;
beforeEach(() => {
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    await run(tx);
  });
  const invalidate = spyOn(settings, "invalidateSettingsCache").mockResolvedValue();
  restoreTransaction = () => {
    begin.mockRestore();
    invalidate.mockRestore();
  };
});
afterEach(() => restoreTransaction());

test("only instance administrators configure validated storage settings", async () => {
  const identity = testIdentity("00000000-0000-4000-8000-000000000001");
  const read = spyOn(app.settings, "read").mockImplementation(async (key) => ({
    stored: "readable" as const,
    value: {
      "assistant.storage_file_mib": 50,
      "assistant.storage_total_mib": 250,
      "assistant.rsql_url": "",
      "assistant.rsql_api_token": "",
    }[key],
  }));
  const write = spyOn(settings, "set").mockResolvedValue();
  try {
    await expect(storageSettings.read(identity)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(storageSettings.write({ fileMiB: 50, totalMiB: 250 }, identity)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(write).not.toHaveBeenCalled();
    identity.user.roles = ["admin"];
    expect(await storageSettings.read(identity)).toMatchObject({
      fileMiB: 50,
      totalMiB: 250,
      unreadable: { "assistant.storage_file_mib": false, "assistant.storage_total_mib": false },
    });
    for (const value of [
      { fileMiB: 0, totalMiB: 250 },
      { fileMiB: 65, totalMiB: 250 },
      { fileMiB: 50, totalMiB: 1.5 },
    ]) {
      await expect(storageSettings.write(value, identity)).rejects.toThrow();
    }
    expect(write).not.toHaveBeenCalled();
    await storageSettings.write({ fileMiB: 64, totalMiB: 500 }, identity);
    expect(write).toHaveBeenCalledWith("assistant.storage_file_mib", 64, tx, { replaceUnreadable: false });
    expect(write).toHaveBeenCalledWith("assistant.storage_total_mib", 500, tx, { replaceUnreadable: false });
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});

test("storage shows unreadable per key and preflights a full save before writing any fallback", async () => {
  const identity = testIdentity("00000000-0000-4000-8000-000000000001");
  identity.user.roles = ["admin"];
  const read = spyOn(app.settings, "read").mockImplementation(async (key) => ({
    value: {
      "assistant.storage_file_mib": 50,
      "assistant.storage_total_mib": 250,
      "assistant.rsql_url": "",
      "assistant.rsql_api_token": "",
    }[key],
    stored: key === "assistant.storage_total_mib" ? "unreadable" : "readable",
  }));
  const write = spyOn(settings, "set").mockResolvedValue();
  try {
    expect((await storageSettings.read(identity)).unreadable).toEqual({
      "assistant.storage_file_mib": false,
      "assistant.storage_total_mib": true,
    });
    await expect(storageSettings.write({ fileMiB: 64, totalMiB: 250 }, identity)).rejects.toMatchObject({ code: "setting_unreadable" });
    expect(write).not.toHaveBeenCalled();
    await storageSettings.write({ fileMiB: 64 }, identity);
    expect(write.mock.calls).toEqual([["assistant.storage_file_mib", 64, tx, { replaceUnreadable: false }]]);
    write.mockClear();
    await storageSettings.write({ totalMiB: 250, replaceUnreadable: ["assistant.storage_total_mib"] }, identity);
    expect(write.mock.calls).toEqual([["assistant.storage_total_mib", 250, tx, { replaceUnreadable: true }]]);
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});
