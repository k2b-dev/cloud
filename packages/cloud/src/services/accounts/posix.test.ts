import { expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { DEFAULT_LINUX_IDENTITY_CONFIGURATION } from "../../contracts/posix";
import { audit } from "../audit";
import * as settings from "../settings";
import { createPosixService } from "./posix";

test("Linux identity configuration replaces the complete admin input in its audit transaction", async () => {
  const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  const tx = new Proxy(client, {
    apply(_target, _receiver, [strings]) {
      if (!strings.join("?").trim().startsWith("LOCK TABLE")) throw new Error("Only table locks expected");
      return Promise.resolve([]);
    },
  });
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    await run(tx);
  });
  const write = spyOn(settings, "set").mockResolvedValue();
  const record = spyOn(audit, "record").mockResolvedValue();
  const invalidate = spyOn(settings, "invalidateSettingsCache").mockResolvedValue();
  const input = { ...DEFAULT_LINUX_IDENTITY_CONFIGURATION, homeTemplate: "/srv/home/{username}" };
  try {
    expect(await createPosixService().configure({ id: "00000000-0000-4000-8000-000000000001", roles: ["admin"] }, input)).toEqual(input);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("linux.identity_config", JSON.stringify(input), tx, { replaceUnreadable: true });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "accounts.linux.configure", metadata: input }), tx);
    expect(invalidate).toHaveBeenCalledWith(["linux.identity_config"]);
  } finally {
    for (const spy of [begin, write, record, invalidate]) spy.mockRestore();
    await client.close();
  }
});
