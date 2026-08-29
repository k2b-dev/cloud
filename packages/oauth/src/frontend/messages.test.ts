import { describe, expect, test } from "bun:test";
import { oauthMessages } from "./messages";

describe("OAuth messages", () => {
  test("keeps every locale complete", () => expect(oauthMessages.check()).toEqual([]));
  test("falls back from regional German", () =>
    expect(oauthMessages.resolve(["de-CH"]).t.authorizationFailed).toBe("Autorisierung fehlgeschlagen"));
});
