import { expect, test } from "bun:test";
import { messages } from "../src/frontend/messages";
import { apiErrorMessage, errorMessages, ProjectValidationError } from "../src/errors";
test("Kit UI and error catalogs are complete with regional fallback", () => {
  expect(messages.check()).toEqual([]);
  expect(errorMessages.check()).toEqual([]);
  expect(messages.resolve(["de-CH"]).t.duplicatePath).toBe(messages.resolve(["de"]).t.duplicatePath);
  expect(apiErrorMessage("REVISION_CONFLICT", "de-CH")).toContain("Entwurf bleibt erhalten");
  expect(apiErrorMessage("REVISION_CONFLICT", "en")).toContain("Your edits are preserved");
  expect(apiErrorMessage("LAST_ADMIN", "de")).toContain("Administrator");
  expect(new ProjectValidationError("missing", "helper.js", "main.js").localized("de")).toBe("main.js: Modul fehlt: helper.js");
});
