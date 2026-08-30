import { describe, expect, test } from "bun:test";
import { err } from "@k2b/stdlib";
import { checkFilesServiceMessages, filesApiErrorMessage, localizeFilesError } from "./messages";

describe("Files service messages", () => {
  test("covers German and preserves stable service error fields", () => {
    expect(checkFilesServiceMessages()).toEqual([]);
    expect(localizeFilesError(err.notFound("File"), "de-CH")).toEqual({
      code: "NOT_FOUND",
      status: 404,
      message: "Die angeforderte Files-Ressource wurde nicht gefunden",
    });
  });

  test("keeps concurrent locale resolution isolated", async () => {
    const [english, german] = await Promise.all([
      Promise.resolve().then(() => filesApiErrorMessage(403, "en")),
      Promise.resolve().then(() => filesApiErrorMessage(403, "de-CH")),
    ]);
    expect(english).toBe("You do not have access to this file storage");
    expect(german).toBe("Du hast keinen Zugriff auf diesen Dateispeicher");
  });
});
