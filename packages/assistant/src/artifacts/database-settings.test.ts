import { expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { app } from "../config";
import { artifactDatabase } from "./database";
import { testIdentity } from "./test-identity";

for (const token of [undefined, ""]) {
  test(`database configuration replaces explicit values and ${token === undefined ? "leaves an omitted token untouched" : "writes a supplied token"}`, async () => {
    const identity = testIdentity("00000000-0000-4000-8000-000000000001");
    identity.user.roles = ["admin"];
    const read = spyOn(app.settings, "get").mockImplementation(
      async (key) =>
        ({
          "assistant.storage_file_mib": 50,
          "assistant.storage_total_mib": 250,
          "assistant.rsql_url": "https://saved.test",
          "assistant.rsql_api_token": "",
        })[key],
    );
    const write = spyOn(app.settings, "set").mockResolvedValue();
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
      expect(write).toHaveBeenCalledWith("assistant.rsql_url", "", { replaceUnreadable: true });
      expect(write).toHaveBeenCalledTimes(token === undefined ? 1 : 2);
      if (token !== undefined) expect(write).toHaveBeenCalledWith("assistant.rsql_api_token", token, { replaceUnreadable: true });
    } finally {
      for (const spy of [read, write, begin]) spy.mockRestore();
      await client.close();
    }
  });
}
