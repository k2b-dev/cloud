import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { localizeNotebookServiceMessage, localizeNotebookSnapshotField, notebookServiceMessages } from "../service/messages";
import { notebookApiMessages } from "./messages";
import { localizeNotebookValidationIssue, notebookV } from "./validator";

describe("notebook API messages", () => {
  test("keeps catalogs complete and resolves regional German locales", () => {
    expect(notebookApiMessages.check()).toEqual([]);
    expect(notebookServiceMessages.check()).toEqual([]);
    expect(notebookApiMessages.resolve(["de-CH"]).t.accessDenied).toBe("Zugriff verweigert");
    expect(notebookApiMessages.resolve(["fr"]).t.accessDenied).toBe("Access denied");
  });

  test("projects service errors without changing embedded identifiers", () => {
    expect(localizeNotebookServiceMessage("API key not found", "de-CH")).toBe("API-Schlüssel nicht gefunden");
    expect(localizeNotebookServiceMessage("Note updatedAt mismatch. Expected old, got new.", "de-DE")).toBe(
      "Die Notiz wurde zwischenzeitlich geändert. Lade sie neu und versuche es erneut.",
    );
    expect(
      localizeNotebookServiceMessage(
        "Hetzner Object Storage endpoints must include the location. Use https://nbg1.your-objectstorage.com for region nbg1.",
        "de",
      ),
    ).toContain("https://nbg1.your-objectstorage.com");
    expect(localizeNotebookServiceMessage("Unknown provider detail", "de")).toBe("Unknown provider detail");
    expect(localizeNotebookServiceMessage("API key not found", "fr")).toBe("API key not found");
    expect(localizeNotebookSnapshotField("secret access key", "de-CH")).toBe("geheimer Zugriffsschlüssel");
  });

  test("localizes Zod validation text at the request edge", () => {
    expect(localizeNotebookValidationIssue("Invalid input: expected string, received undefined", "de-CH")).toBe("Angabe erforderlich");
    expect(localizeNotebookValidationIssue("Too big: expected string to have <=100 characters", "de-DE")).toBe("Der Wert ist zu groß");
    expect(localizeNotebookValidationIssue("Invalid UUID", "de")).toBe("Ungültiges Format");
    expect(localizeNotebookValidationIssue("Invalid UUID", "en")).toBe("Invalid UUID");
  });

  test("uses the request locale in validation responses", async () => {
    const app = new Hono().post("/", notebookV("json", z.object({ name: z.string() })), (c) => c.json({ ok: true }));
    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloud-locale": "de-CH" },
      body: "{}",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "name: Angabe erforderlich" });
  });
});
