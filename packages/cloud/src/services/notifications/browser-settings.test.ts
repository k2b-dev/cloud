import { expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import webpush from "web-push";
import { useUnitClients } from "../../../../../scripts/fixtures/unit-clients";
import { sql } from "../../runtime/clients";
import { coreSettings } from "../settings/api";
import * as settingsStore from "../settings/store";
import { SettingUnreadableError } from "../settings/store";
import { browserNotifications } from "./browser";
import { getNotificationChannel } from "./channels";

useUnitClients();

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
  const read = spyOn(settingsStore, "readKeyState");
  const get = spyOn(coreSettings, "get").mockResolvedValue("");
  const write = spyOn(settingsStore, "writeKey").mockRejectedValue(new Error("Must not write"));
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

test("VAPID initialization keeps settings on its lock-owning transaction and invalidates after commit", async () => {
  const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  const events: string[] = [];
  const tx = new Proxy(client, {
    apply: (_target, _this, args) => {
      expect(String(args[0])).toContain("pg_advisory_xact_lock");
      events.push("lock");
      return Promise.resolve([]);
    },
  });
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    const result = await run(tx);
    events.push("commit");
    return result;
  });
  // Pool-level reads/writes under this transaction can sit behind a concurrent
  // index build waiting for the transaction itself. Reject any such escape.
  const poolRead = spyOn(coreSettings, "read").mockRejectedValue(new Error("Pool read inside transaction"));
  const poolWrite = spyOn(coreSettings, "set").mockRejectedValue(new Error("Pool write inside transaction"));
  const read = spyOn(settingsStore, "readKeyState").mockImplementation(async (key, db) => {
    expect(db).toBe(tx);
    events.push(`read:${key}`);
    return { value: "", stored: "none" };
  });
  const write = spyOn(settingsStore, "writeKey").mockImplementation(async (key, _value, db) => {
    expect(db).toBe(tx);
    events.push(`write:${key}`);
  });
  const invalidate = spyOn(settingsStore, "invalidateSettingsCache").mockImplementation(async (keys) => {
    expect(keys).toEqual([publicKey, privateKey]);
    expect(events.at(-1)).toBe("commit");
    events.push("invalidate");
  });
  const generated = webpush.generateVAPIDKeys();
  const generate = spyOn(webpush, "generateVAPIDKeys").mockReturnValue(generated);
  try {
    // A failed second write must leave both keys uncommitted and the cache intact.
    const failure = new Error("Private key write failed");
    write.mockImplementationOnce(async (_key, _value, db) => {
      expect(db).toBe(tx);
    });
    write.mockImplementationOnce(async (_key, _value, db) => {
      expect(db).toBe(tx);
      throw failure;
    });
    await expect(browserNotifications.configuration()).rejects.toBe(failure);
    expect(events).not.toContain("commit");
    expect(invalidate).not.toHaveBeenCalled();
    events.length = 0;
    await expect(browserNotifications.configuration()).resolves.toEqual({ publicKey: generated.publicKey });
    expect(events).toEqual([
      "lock",
      `read:${publicKey}`,
      `read:${privateKey}`,
      `write:${publicKey}`,
      `write:${privateKey}`,
      "commit",
      "invalidate",
    ]);
    expect(poolRead).not.toHaveBeenCalled();
    expect(poolWrite).not.toHaveBeenCalled();
    expect(write.mock.calls.slice(-2).map(([key, value]) => [key, value])).toEqual([
      [publicKey, generated.publicKey],
      [privateKey, generated.privateKey],
    ]);
  } finally {
    for (const spy of [begin, poolRead, poolWrite, read, write, invalidate, generate]) spy.mockRestore();
    await client.close();
  }
});
