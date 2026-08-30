import { describe, expect, test } from "bun:test";
import { checkContactsMessages, contactsApiErrorMessage, contactsMessages } from "./messages";

describe("Contacts service messages", () => {
  test("covers German with de-CH fallback", () => {
    expect(checkContactsMessages()).toEqual([]);
    expect(contactsMessages("de-CH").contactBookNotFound).toBe("Das Kontaktbuch wurde nicht gefunden");
  });

  test("localizes stable API status semantics without cross-request state", async () => {
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => contactsApiErrorMessage(404, "en")),
      Promise.resolve().then(() => contactsApiErrorMessage(404, "de-CH")),
    ]);
    expect(english).toBe("The requested Contacts resource was not found");
    expect(german).toBe("Die angeforderte Contacts-Ressource wurde nicht gefunden");
  });
});
