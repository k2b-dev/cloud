import { expect, test } from "bun:test";
import { rsqlAllowlist } from "./database";

test("rsql defaults to its shipped host, explicit values replace it, and invalid entries fail startup", () => {
  const original = process.env.ASSISTANT_RSQL_ALLOWED_TARGETS;
  try {
    delete process.env.ASSISTANT_RSQL_ALLOWED_TARGETS;
    expect([...rsqlAllowlist().hosts]).toEqual(["rsql"]);
    process.env.ASSISTANT_RSQL_ALLOWED_TARGETS = "db.internal";
    expect([...rsqlAllowlist().hosts]).toEqual(["db.internal"]);
    for (const entry of ["0.0.0.0/0", "::/0", "http://rsql"]) {
      process.env.ASSISTANT_RSQL_ALLOWED_TARGETS = entry;
      expect(rsqlAllowlist).toThrow("ASSISTANT_RSQL_ALLOWED_TARGETS");
    }
  } finally {
    if (original === undefined) delete process.env.ASSISTANT_RSQL_ALLOWED_TARGETS;
    else process.env.ASSISTANT_RSQL_ALLOWED_TARGETS = original;
  }
});
