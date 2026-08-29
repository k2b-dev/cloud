import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { apiMessages, gridsApiMessages } from "./messages";

describe("grids API messages", () => {
  test("keeps every supported locale complete", () => {
    expect(gridsApiMessages.check()).toEqual([]);
  });

  test("resolves regional German locales and falls back to English", () => {
    expect(gridsApiMessages.resolve(["de-CH"]).t.tableNotFound).toBe("Tabelle nicht gefunden");
    expect(gridsApiMessages.resolve(["fr"]).t.tableNotFound).toBe("Table not found");
  });

  test("uses the request locale at an API boundary", async () => {
    const app = new Hono().get("/missing", (c) => c.json({ message: apiMessages(c).tableNotFound }, 404));

    const response = await app.request("/missing", { headers: { "x-cloud-locale": "de-CH" } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "Tabelle nicht gefunden" });
  });

  test("provides a stable localized validation message", () => {
    expect(gridsApiMessages.resolve(["en"]).t.invalidRequest).toBe("The request is invalid.");
    expect(gridsApiMessages.resolve(["de-CH"]).t.invalidRequest).toBe("Die Anfrage ist ungültig.");
  });
});
