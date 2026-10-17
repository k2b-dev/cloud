import { expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import webpush from "web-push";
import { coreSettings } from "../settings/api";
import { SettingUnreadableError } from "../settings/store";
import { browserNotifications } from "./browser";
import { getNotificationChannel } from "./channels";

const publicKey = "notifications.web_push_public_key";
const privateKey = "notifications.web_push_private_key";

test.each(["configuration", "start"])("unreadable VAPID keys preserve storage and retry (%s)", async (operation) => {
  // A lazy SQL client supplies the transaction type; the proxy handles only the advisory lock.
  const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  let locks = 0;
  const tx = new Proxy(client, {
    apply: (_target, _this, args) => {
      expect(String(args[0])).toContain("pg_advisory_xact_lock");
      locks++;
      return Promise.resolve([]);
    },
  });
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    return await run(tx);
  });
  const read = spyOn(coreSettings, "read");
  const get = spyOn(coreSettings, "get").mockResolvedValue("");
  const write = spyOn(coreSettings, "set").mockRejectedValue(new Error("Must not write"));
  const generate = spyOn(webpush, "generateVAPIDKeys");
  const configure = spyOn(webpush, "setVapidDetails");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const unreadable of [publicKey, privateKey]) {
      read
        .mockResolvedValueOnce({ value: "fallback-public", stored: unreadable === publicKey ? "unreadable" : "readable" })
        .mockResolvedValueOnce({ value: "fallback-private", stored: unreadable === privateKey ? "unreadable" : "readable" });
      if (operation === "start") {
        await expect(browserNotifications.start()).resolves.toBeUndefined();
        expect(getNotificationChannel("browser")).toBeDefined();
      } else {
        await expect(browserNotifications.configuration()).rejects.toBeInstanceOf(SettingUnreadableError);
      }
      expect(warn.mock.calls.at(-1)).toEqual([`[notifications] cannot read setting "${unreadable}"; keeping stored VAPID keys unchanged`]);
    }
    expect(locks).toBe(2);
    expect(generate).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fallback");
  } finally {
    for (const spy of [begin, read, get, write, generate, configure, warn]) spy.mockRestore();
    await client.close();
  }
});

test("browser notification startup still rejects other configuration failures", async () => {
  const error = new Error("Database unavailable");
  const begin = spyOn(sql, "begin").mockRejectedValue(error);
  const get = spyOn(coreSettings, "get").mockResolvedValue("");
  try {
    await expect(browserNotifications.start()).rejects.toBe(error);
  } finally {
    for (const spy of [begin, get]) spy.mockRestore();
  }
});
