import { expect, test } from "bun:test";
import { aiSettingsMessages } from "./ai-settings-messages";

for (const locale of ["en", "de"]) {
  test(`${locale}: both instruction fields explain model visibility`, () => {
    const t = aiSettingsMessages.resolve([locale]).t;
    for (const description of [t.globalInstructionsDescription, t.localClientInstructionsDescription]) {
      expect(description).toContain(locale === "de" ? "können in seinen Antworten erscheinen" : "can appear in its answers");
      expect(description).toContain(
        locale === "de" ? "keine Geheimnisse oder vertraulichen Richtlinien" : "Do not put secrets or confidential policy",
      );
    }
  });
}
