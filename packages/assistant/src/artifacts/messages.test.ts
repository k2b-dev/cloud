import { expect, test } from "bun:test";
import { artifactMessages } from "../chat-code/messages";
import { machineMessages } from "./machine-messages";

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
    expect(t.DB_TARGET_BLOCKED).toContain("assistant.rsql_allowed_targets");
    expect(t.DB_TARGET_BLOCKED).not.toBe(t.DB_UNREACHABLE);
  }
});

// Concept v28 words: Studio's machine rights go to agents and API keys; "Dienstkonto" is only the account Code runs as,
// and that account gets no execution rights.
test("machine execution help names agents and API keys, never service accounts", () => {
  for (const locale of ["en", "de"]) {
    const t = machineMessages.resolve([locale]).t;
    for (const text of [t.help, t.empty]) {
      expect(text).not.toMatch(/Dienstkonto|service account/i);
      expect(text).toContain(locale === "de" ? "API Key" : "API key");
    }
  }
});
