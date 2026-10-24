import { describe, expect, test } from "bun:test";
import { appAccessMessages } from "./app-access-messages";

describe("appAccessMessages", () => {
  test("keeps both catalogs structurally complete", () => {
    expect(appAccessMessages.check()).toEqual([]);
  });

  test("names the remaining managers with a verb that agrees with their number", () => {
    const de = appAccessMessages.resolve(["de"]).t;
    const en = appAccessMessages.resolve(["en"]).t;

    expect(de.remainingManagers({ managers: "Eva Beispiel", count: 1 })).toBe("Eva Beispiel verwaltet den Zugriff weiter.");
    expect(de.remainingManagers({ managers: "Eva Beispiel und Finanzteam", count: 2 })).toBe(
      "Eva Beispiel und Finanzteam verwalten den Zugriff weiter.",
    );
    expect(de.remainingManagers({ managers: "", count: 0 })).toBe("");
    expect(en.remainingManagers({ managers: "Eva Example", count: 1 })).toBe("Eva Example still manages access.");
    expect(en.remainingManagers({ managers: "Eva Example and Finance", count: 2 })).toBe("Eva Example and Finance still manage access.");
  });

  test("counts a group's people in the row subtitle", () => {
    const de = appAccessMessages.resolve(["de"]).t;

    expect([0, 1, 4].map((count) => de.group({ count }))).toEqual(["Gruppe · keine Personen", "Gruppe · 1 Person", "Gruppe · 4 Personen"]);
    expect(appAccessMessages.resolve(["en"]).t.group({ count: 1200 })).toBe("Group · 1,200 people");
  });
});
