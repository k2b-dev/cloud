import { describe, expect, test } from "bun:test";
import { validateFormConfig } from "./form-config-validation";
import { formMessagesFor } from "./form-messages";
import { create } from "./forms";

describe("Form service messages", () => {
  test("uses German for regional German locales", async () => {
    const messages = formMessagesFor("de-CH");
    const invalidConfig = await validateFormConfig("unused", { fields: "invalid" }, "de-CH");
    const missingName = await create({ tableId: "unused", name: "" }, null, "de-CH");

    expect(messages.quickAdd).toBe("Schnellerfassung");
    expect(invalidConfig.ok).toBe(false);
    if (!invalidConfig.ok) expect(invalidConfig.error.message).toBe("Die Formularkonfiguration ist ungültig.");
    expect(missingName.ok).toBe(false);
    if (!missingName.ok) expect(missingName.error.message).toBe("Ein Name ist erforderlich.");
  });

  test("falls back to English for unsupported locales", () => {
    expect(formMessagesFor("fr").quickAdd).toBe("Quick add");
  });
});
