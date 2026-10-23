import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as settings from "@k2b/cloud/services/settings";
import { SQL, sql } from "bun";
import { app } from "../config";
import { artifactDatabase } from "./database";
import { testIdentity } from "./test-identity";

let restoreCache: () => void;
beforeEach(() => {
  const invalidate = spyOn(settings, "invalidateSettingsCache").mockResolvedValue();
  restoreCache = () => invalidate.mockRestore();
});
afterEach(() => restoreCache());

for (const token of [undefined, ""]) {
  test(`database configuration replaces explicit values and ${token === undefined ? "leaves an omitted token untouched" : "writes a supplied token"}`, async () => {
    const identity = testIdentity("00000000-0000-4000-8000-000000000001");
    identity.user.roles = ["admin"];
    const read = spyOn(app.settings, "read").mockImplementation(async (key) => ({
      stored: "readable" as const,
      value: {
        "assistant.storage_file_mib": 50,
        "assistant.storage_total_mib": 250,
        "assistant.rsql_url": "https://saved.test",
        "assistant.rsql_api_token": "",
      }[key],
    }));
    const write = spyOn(settings, "set").mockResolvedValue();
    const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
      savepoint: () => {
        throw new Error("Unexpected savepoint");
      },
    });
    const tx = new Proxy(client, {
      apply(_target, _receiver, [strings]) {
        const query = strings.join("?");
        if (query.includes("pg_advisory_xact_lock")) return Promise.resolve([]);
        if (query.includes("count(*)")) return Promise.resolve([{ count: 0 }]);
        throw new Error(`Unexpected SQL query: ${query}`);
      },
    });
    const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
      if (typeof run !== "function") throw new Error("Expected transaction callback");
      await run(tx);
    });
    try {
      await artifactDatabase.configure({ url: "", ...(token === undefined ? {} : { token }) }, identity);
      expect(write).toHaveBeenCalledWith("assistant.rsql_url", "", tx, { replaceUnreadable: false });
      expect(write).toHaveBeenCalledTimes(token === undefined ? 1 : 2);
      if (token !== undefined) expect(write).toHaveBeenCalledWith("assistant.rsql_api_token", token, tx, { replaceUnreadable: false });
    } finally {
      for (const spy of [read, write, begin]) spy.mockRestore();
      await client.close();
    }
  });
}

test("database unreadable URL and token are independent and implicit replacement fails before writes", async () => {
  const identity = testIdentity("00000000-0000-4000-8000-000000000001");
  identity.user.roles = ["admin"];
  const read = spyOn(app.settings, "read").mockResolvedValue({ value: "", stored: "unreadable" });
  const write = spyOn(settings, "set").mockResolvedValue();
  const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  const tx = new Proxy(client, {
    apply() {
      return Promise.resolve([]);
    },
  });
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction");
    await run(tx);
  });
  try {
    expect(await artifactDatabase.settings(identity)).toEqual({
      url: "",
      tokenSet: false,
      unreadable: { "assistant.rsql_url": true, "assistant.rsql_api_token": true },
    });
    await expect(artifactDatabase.configure({ url: "", token: "" }, identity)).rejects.toMatchObject({ code: "setting_unreadable" });
    expect(write).not.toHaveBeenCalled();
    await expect(artifactDatabase.configure({}, identity, true)).rejects.toMatchObject({ code: "setting_unreadable" });
    await artifactDatabase.configure({ token: "", replaceUnreadable: ["assistant.rsql_api_token"] }, identity);
    expect(write.mock.calls).toEqual([["assistant.rsql_api_token", "", tx, { replaceUnreadable: true }]]);
  } finally {
    for (const spy of [read, write, begin]) spy.mockRestore();
    await client.close();
  }
});
