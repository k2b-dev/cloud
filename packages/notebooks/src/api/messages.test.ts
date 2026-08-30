import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { localizeNotebookSnapshotField, notebookServiceMessages } from "../service/messages";
import { notebookApiMessages } from "./messages";
import { localizeNotebookValidationIssue, notebookV } from "./validator";

describe("notebook API messages", () => {
  test("keeps catalogs complete and resolves regional German locales", () => {
    expect(notebookApiMessages.check()).toEqual([]);
    expect(notebookServiceMessages.check()).toEqual([]);
    expect(notebookApiMessages.resolve(["de-CH"]).t.accessDenied).toBe("Zugriff verweigert");
    expect(notebookApiMessages.resolve(["fr"]).t.accessDenied).toBe("Access denied");
  });

  test("localizes stable snapshot field identifiers", () => {
    expect(localizeNotebookSnapshotField("secret access key", "de-CH")).toBe("geheimer Zugriffsschlüssel");
  });

  test("localizes Zod validation text at the request edge", () => {
    expect(localizeNotebookValidationIssue("Invalid input: expected string, received undefined", "de-CH")).toBe("Ungültiger Wert");
    expect(localizeNotebookValidationIssue("Too big: expected string to have <=100 characters", "de-DE")).toBe("Ungültiger Wert");
    expect(localizeNotebookValidationIssue("Invalid UUID", "de")).toBe("Ungültiger Wert");
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
    expect(await response.json()).toEqual({ message: "name: Ungültiger Wert" });
  });
});
