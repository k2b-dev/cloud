import { describe, expect, test } from "bun:test";
import { accountsApiErrorMessage, accountsApiMessages, checkAccountsApiMessages } from "./messages";

describe("Accounts API messages", () => {
  test("covers German with de-CH fallback", () => {
    expect(checkAccountsApiMessages()).toEqual([]);
    expect(accountsApiMessages("de-CH").passwordReset).toBe("Passwort zurückgesetzt.");
  });

  test("keeps concurrent request locales isolated", async () => {
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => accountsApiErrorMessage(404, "en")),
      Promise.resolve().then(() => accountsApiErrorMessage(404, "de-CH")),
    ]);
    expect(english).toBe("The requested Accounts resource was not found");
    expect(german).toBe("Die angeforderte Accounts-Ressource wurde nicht gefunden");
  });
});
