import { expect, spyOn, test } from "bun:test";
import { app } from "../config";
import { storageSettings } from "./storage-settings";
import { testIdentity } from "./test-identity";

test("only instance administrators configure validated storage settings", async () => {
  const identity = testIdentity("00000000-0000-4000-8000-000000000001");
  const read = spyOn(app.settings, "get").mockImplementation(
    async (key) =>
      ({
        "assistant.storage_file_mib": 50,
        "assistant.storage_total_mib": 250,
        "assistant.rsql_url": "",
        "assistant.rsql_api_token": "",
      })[key],
  );
  const write = spyOn(app.settings, "set").mockResolvedValue();
  try {
    await expect(storageSettings.read(identity)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(storageSettings.write({ fileMiB: 50, totalMiB: 250 }, identity)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(write).not.toHaveBeenCalled();
    identity.user.roles = ["admin"];
    expect(await storageSettings.read(identity)).toEqual({ fileMiB: 50, totalMiB: 250 });
    for (const value of [
      { fileMiB: 0, totalMiB: 250 },
      { fileMiB: 65, totalMiB: 250 },
      { fileMiB: 50, totalMiB: 1.5 },
    ]) {
      await expect(storageSettings.write(value, identity)).rejects.toThrow();
    }
    expect(write).not.toHaveBeenCalled();
    await storageSettings.write({ fileMiB: 64, totalMiB: 500 }, identity);
    expect(write).toHaveBeenCalledWith("assistant.storage_file_mib", 64);
    expect(write).toHaveBeenCalledWith("assistant.storage_total_mib", 500);
  } finally {
    read.mockRestore();
    write.mockRestore();
  }
});
