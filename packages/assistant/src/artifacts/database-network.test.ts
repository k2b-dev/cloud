import { expect, mock, spyOn, test } from "bun:test";
import { app } from "../config";
import { rsqlAllowlist } from "./database";

test("rsql reads current targets for each new request and rejects invalid stored entries", async () => {
  const get = spyOn(app.settings, "get");
  try {
    get.mockResolvedValue(["rsql"]);
    expect([...(await rsqlAllowlist()).hosts]).toEqual(["rsql"]);
    get.mockResolvedValue(["db.internal"]);
    expect([...(await rsqlAllowlist()).hosts]).toEqual(["db.internal"]);
    for (const entry of ["0.0.0.0/0", "::/0", "http://rsql"]) {
      get.mockResolvedValue([entry]);
      await expect(rsqlAllowlist()).rejects.toThrow("assistant.rsql_allowed_targets");
    }
  } finally {
    mock.restore();
  }
});
