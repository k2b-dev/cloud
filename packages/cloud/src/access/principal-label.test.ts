import { describe, expect, test } from "bun:test";
import type { Principal, ServiceAccountKind } from "../contracts/shared";
import { principalLabel } from "./principal-label";

const id = "11111111-1111-4111-8111-111111111111";
describe("principalLabel", () => {
  const cases: { principal: Principal; serviceAccountKind?: ServiceAccountKind; en: string; de: string }[] = [
    { principal: { type: "user", userId: id }, en: "Unknown person", de: "Unbekannte Person" },
    { principal: { type: "group", groupId: id }, en: "Deleted group", de: "Gelöschte Gruppe" },
    { principal: { type: "service_account", serviceAccountId: id }, en: "Unknown service account", de: "Unbekanntes Dienstkonto" },
    {
      principal: { type: "service_account", serviceAccountId: id },
      serviceAccountKind: "agent",
      en: "Unknown agent",
      de: "Unbekannter Agent",
    },
    { principal: { type: "authenticated" }, en: "All users (including guests)", de: "Alle Benutzer einschließlich Gäste" },
    { principal: { type: "public" }, en: "Public", de: "Öffentlich" },
  ];
  for (const locale of ["en", "de"] as const) {
    test(`${locale}: missing names never become IDs`, () => {
      for (const entry of cases) {
        for (const displayName of [undefined, null, ""]) {
          expect(principalLabel({ ...entry, displayName }, locale)).toBe(entry[locale]);
        }
      }
    });
    test(`${locale}: audiences ignore names and groups use the locale's display form`, () => {
      expect(principalLabel({ principal: { type: "public" }, displayName: "Public" }, locale)).toBe(cases[5]![locale]);
      expect(principalLabel({ principal: { type: "authenticated" }, displayName: "Old English label" }, locale)).toBe(cases[4]![locale]);
      expect(principalLabel({ principal: { type: "group", groupId: id }, displayName: "finance-team" }, locale)).toBe(
        locale === "de" ? "Finance-Team" : "finance-team",
      );
      expect(principalLabel({ principal: { type: "user", userId: id }, displayName: "Ada Example" }, locale)).toBe("Ada Example");
    });
  }
  test("an absent locale uses the catalog's base locale", () => {
    expect(principalLabel(cases[0]!, null)).toBe("Unknown person");
  });
});
