import { describe, expect, test } from "bun:test";
import { err } from "@k2b/stdlib";
import { checkSpacesMessages, localizeSpacesError, spacesApiErrorMessage, spacesMessages } from "./messages";

describe("Spaces messages", () => {
  test("keeps catalogs complete and falls back from regional German locales", () => {
    expect(checkSpacesMessages()).toEqual([]);
    expect(spacesMessages("de-CH").widgetTitle).toBe("Heute");
    expect(spacesMessages("de-CH").starterInProgress).toBe("In Arbeit");
    expect(spacesMessages("fr").widgetTitle).toBe("Today");
  });

  test("localizes errors from stable codes and statuses", () => {
    expect(localizeSpacesError(err.notFound("Item"), "de-CH")).toEqual({
      code: "NOT_FOUND",
      status: 404,
      message: "Die angeforderte Spaces-Ressource wurde nicht gefunden",
    });
    expect(spacesApiErrorMessage(409, "de-CH")).toBe("Die Spaces-Änderung steht im Konflikt mit dem aktuellen Stand");
    expect(spacesApiErrorMessage(500, "en")).toBe("The Spaces operation failed");
  });

  test("keeps concurrent locale resolution isolated", async () => {
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => spacesApiErrorMessage(404, "en")),
      Promise.resolve().then(() => spacesApiErrorMessage(404, "de-CH")),
    ]);
    expect(english).toBe("The requested Spaces resource was not found");
    expect(german).toBe("Die angeforderte Spaces-Ressource wurde nicht gefunden");
  });
});
