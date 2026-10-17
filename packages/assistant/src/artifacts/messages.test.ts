import { expect, test } from "bun:test";
import { artifactMessages } from "./messages";

test("Studio messages keep matching locale contracts", () => {
  expect(artifactMessages.check()).toEqual([]);
});

test("names the Studio admin page like the other per-app admin pages", () => {
  expect(artifactMessages.resolve(["en"]).t.administration).toBe("Studio administration");
  expect(artifactMessages.resolve(["de"]).t.administration).toBe("Studio-Administration");
});

test("blocked database targets name the operator setting in both locales", () => {
  for (const locale of ["en", "de"]) {
    const t = artifactMessages.resolve([locale]).t;
    expect(t.DB_TARGET_BLOCKED).toContain("ASSISTANT_RSQL_ALLOWED_TARGETS");
    expect(t.DB_TARGET_BLOCKED).not.toBe(t.DB_UNREACHABLE);
  }
});
