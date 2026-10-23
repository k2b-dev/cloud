import { describe, expect, test } from "bun:test";
import { resolveSettingPresentation, toLegacySettingDefs, validateSettingValue } from "./defaults";

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

test("integer settings reject fractions and unsafe values without changing ordinary numbers", () => {
  const [integer, decimal] = toLegacySettingDefs({
    "example.count": { kind: "number", default: 12, min: 1, integer: true },
    "example.ratio": { kind: "number", default: 0.5 },
  });
  expect(validateSettingValue(integer!, "12")).toEqual({ ok: true, value: 12 });
  for (const value of [1.5, 0, Number.MAX_SAFE_INTEGER + 1, Infinity]) expect(validateSettingValue(integer!, value).ok).toBe(false);
  expect(validateSettingValue(decimal!, 1.5)).toEqual({ ok: true, value: 1.5 });
});

test("email validation handles long adversarial values with linear work", () => {
  const [email] = toLegacySettingDefs({ "example.email": { kind: "email", default: "" } });
  for (const [value, ok] of [
    ["", true],
    ["a@b.c", true],
    ["a@.b", false],
    ["a@b.", false],
    ["a@@b.c", false],
    ["a@b..", true],
    ["a b@c.d", false],
  ] as const) {
    expect(validateSettingValue(email!, value).ok).toBe(ok);
  }
  const value = "!@!." + "!.".repeat(100_000) + "@";
  const started = performance.now();
  expect(validateSettingValue(email!, value).ok).toBe(false);
  expect(performance.now() - started).toBeLessThan(1_000);
});
