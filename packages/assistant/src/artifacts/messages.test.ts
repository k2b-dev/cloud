import { expect, test } from "bun:test";
import { artifactMessages } from "./messages";

test("Studio messages keep matching locale contracts", () => {
  expect(artifactMessages.check()).toEqual([]);
});

test("names the Studio admin page like the other per-app admin pages", () => {
  expect(artifactMessages.resolve(["en"]).t.administration).toBe("Studio administration");
  expect(artifactMessages.resolve(["de"]).t.administration).toBe("Studio-Administration");
});
