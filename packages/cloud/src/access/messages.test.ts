import { describe, expect, test } from "bun:test";
import { appAccessMessages } from "./app-access-messages";
import { accessMessages } from "./messages";

describe("accessMessages", () => {
  test("keeps both catalogs structurally complete", () => {
    expect(accessMessages.check()).toEqual([]);
  });

  test("the signed-in tier names people and explains separate machine grants", () => {
    const en = accessMessages.resolve(["en"]).t;
    const de = accessMessages.resolve(["de"]).t;
    expect(en.allUsers).toBe("All signed-in people");
    expect(de.allUsers).toBe("Alle angemeldeten Personen");
    expect(en.signedInPermission({ level: "view" })).toBe(
      "Everyone with an account may view, including guests. Agents and service accounts need their own grant.",
    );
    expect(de.signedInPermission({ level: "ansehen" })).toBe(
      "Alle Personen mit Konto dürfen ansehen, auch Gäste. Agenten und Dienstkonten brauchen ein eigenes Recht.",
    );
  });

  test("uses German for regional German locales", () => {
    const { t } = accessMessages.resolve(["de-CH"]);

    expect(t.view).toBe("Ansehen");
    expect(t.revokeConfirm({ name: "Website" })).toContain("sofort den Zugriff");
  });

  test("falls back to English for unsupported locales", () => {
    expect(accessMessages.resolve(["fr-FR"]).t.view).toBe("View");
  });
});

// Concept v28 words: "Dienstkonto" (service account) is only the account Code runs as. A picker finds people, groups and
// agents by name, never a service account, so its placeholder never offers one.
test("picker placeholders name agents, never service accounts", () => {
  for (const [catalog, locale] of [
    [accessMessages.resolve(["en"]).t, "en"],
    [accessMessages.resolve(["de"]).t, "de"],
  ] as const)
    for (const text of [catalog.addAll, catalog.addService]) {
      expect(text).not.toMatch(/Dienstkonto|service account/i);
      expect(text).toContain(locale === "de" ? "Agenten" : "agent");
    }
  for (const locale of ["en", "de"]) {
    const text = appAccessMessages.resolve([locale]).t.add;
    expect(text).not.toMatch(/Dienstkonto|service account/i);
    expect(text).toContain(locale === "de" ? "Agenten" : "agent");
  }
});
