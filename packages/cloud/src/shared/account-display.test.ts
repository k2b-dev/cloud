import { describe, expect, test } from "bun:test";
import { groupDisplayName } from "./account-display";

describe("groupDisplayName", () => {
  test("capitalises each whitespace- or hyphen-separated word in German", () => {
    expect(groupDisplayName("buchhaltung", "de")).toBe("Buchhaltung");
    expect(groupDisplayName("foo bar", "de")).toBe("Foo Bar");
    expect(groupDisplayName("presse-team", "de-DE")).toBe("Presse-Team");
    expect(groupDisplayName("übersetzung", "de")).toBe("Übersetzung");
  });

  test("changes only the first letter and leaves capitals, digits, and underscores alone", () => {
    expect(groupDisplayName("Buchhaltung", "de")).toBe("Buchhaltung");
    expect(groupDisplayName("it-OPS", "de")).toBe("It-OPS");
    expect(groupDisplayName("3d-druck", "de")).toBe("3d-Druck");
    expect(groupDisplayName("web_admins", "de")).toBe("Web_admins");
  });

  test("leaves other locales unchanged", () => {
    expect(groupDisplayName("buchhaltung", "en")).toBe("buchhaltung");
    expect(groupDisplayName("foo bar", "en-US")).toBe("foo bar");
    expect(groupDisplayName("buchhaltung", undefined)).toBe("buchhaltung");
    expect(groupDisplayName("deutsch", "dev")).toBe("deutsch");
  });
});
