import { describe, expect, test } from "bun:test";
import { checkFaqServiceMessages, faqServiceMessages } from "./messages";

describe("FAQ service messages", () => {
  test("covers the German catalog and de-CH fallback", () => {
    expect(checkFaqServiceMessages()).toEqual([]);
    expect(faqServiceMessages("de-CH").notFound).toBe("Der FAQ-Eintrag wurde nicht gefunden");
    expect(faqServiceMessages("en").notFound).toBe("FAQ entry not found");
  });

  test("keeps concurrent locale resolution isolated", async () => {
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => faqServiceMessages("en").deleteFailed),
      Promise.resolve().then(() => faqServiceMessages("de-CH").deleteFailed),
    ]);
    expect(english).toBe("The FAQ entry could not be deleted");
    expect(german).toBe("Der FAQ-Eintrag konnte nicht gelöscht werden");
  });
});
