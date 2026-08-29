import { describe, expect, test } from "bun:test";
import { resolveSettingPresentation, toLegacySettingDefs } from "./defaults";

describe("setting presentation", () => {
  test("inherits the app base locale and resolves regional overlays", () => {
    const [definition] = toLegacySettingDefs(
      {
        "example.endpoint": {
          kind: "url",
          default: "",
          label: "Endpoint",
          description: "Service endpoint.",
          placeholder: "For example, https://service.example",
          presentation: {
            translations: {
              de: {
                label: "Endpunkt",
                description: "Endpunkt des Dienstes.",
                placeholder: "Zum Beispiel https://dienst.example",
              },
            },
          },
        },
      },
      "en",
    );

    expect(resolveSettingPresentation(definition!, "de-CH")).toMatchObject({
      label: "Endpunkt",
      description: "Endpunkt des Dienstes.",
      placeholder: "Zum Beispiel https://dienst.example",
    });
    expect(resolveSettingPresentation(definition!, "fr")).toMatchObject({ label: "Endpoint", description: "Service endpoint." });
  });

  test("rejects invalid and duplicate canonical locale overlays", () => {
    expect(() =>
      toLegacySettingDefs({
        "example.value": {
          kind: "string",
          default: "",
          presentation: { translations: { "not a locale": { label: "Value" } } },
        },
      }),
    ).toThrow("presentation locale");
  });
});
