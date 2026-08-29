import { describe, expect, test } from "bun:test";
import { proxyAuthMessages } from "./messages";

describe("Proxy Auth messages", () => {
  test("keeps every locale complete", () => expect(proxyAuthMessages.check()).toEqual([]));
  test("falls back from regional German", () => expect(proxyAuthMessages.resolve(["de-CH"]).t.newClient).toBe("Neuer Client"));
});
