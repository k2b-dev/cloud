import { describe, expect, test } from "bun:test";
import type { SettingFieldDef } from "./CoreSettingsForm.island";
import { localizeSettingField } from "./setting-copy";

const entry: SettingFieldDef = {
  key: "freeipa.account_transition_policy",
  label: "Account Transition Policy",
  description: "What happens to an account.",
  kind: "enum",
  value: "delete",
  default: "delete",
  resetValue: "delete",
  valueSource: "default",
  resetValueSource: "default",
  isCustom: false,
  unreadable: false,
  group: "freeipa",
  options: [
    { value: "delete", label: "Delete account" },
    { value: "demote_to_local_guest", label: "Make local guest" },
  ],
};

describe("localizeSettingField", () => {
  test("localizes copy and enum options for regional German locales", () => {
    const localized = localizeSettingField(entry, "de-CH");

    expect(localized.label).toBe("Richtlinie für Kontoübergänge");
    expect(localized.options?.map((option) => option.label)).toEqual(["Konto löschen", "In lokales Gastkonto umwandeln"]);
  });

  test("preserves the server-provided English definition", () => {
    expect(localizeSettingField(entry, "en-US")).toBe(entry);
  });
});

test("PDF input budget and timeout copy describe the whole render request", () => {
  const budget = localizeSettingField({ ...entry, key: "gotenberg.max_html_bytes", kind: "number", options: undefined }, "de");
  expect(budget.label).toBe("Maximale Eingabegröße");
  expect(budget.description).toBe("Maximale Größe einer Render-Anfrage: HTML, Kopf- und Fußzeile, Bilder und Schriften zusammen.");
  const timeout = localizeSettingField({ ...entry, key: "gotenberg.timeout_ms", kind: "number", options: undefined }, "de");
  expect(timeout.description).toContain("--api-timeout");
  expect(timeout.description).toContain("Standard 30 s");
});
