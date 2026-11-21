import { expect, test } from "bun:test";
import { codeMessages } from "../server/services/code-account-display";
import { compileCapabilities, resolveCapabilityManifestPresentation } from "./capabilities";

test("owner types supply complete translated account labels without guessing grammar", () => {
  const compiled = compileCapabilities("example", {
    protocolVersion: 2,
    types: {
      item: {
        title: "Item",
        description: "An item.",
        codeAccount: { name: "Code of an item", description: "Service account of an item" },
      },
    },
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          types: {
            item: {
              title: "Postfach",
              codeAccount: { name: "Code eines Postfachs", description: "Dienstkonto eines Postfachs" },
            },
          },
        },
      },
    },
  });
  expect(resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "de-CH").types[0]?.codeAccount).toEqual({
    name: "Code eines Postfachs",
    description: "Dienstkonto eines Postfachs",
  });
  expect(compiled.manifest.types[0]?.codeAccount?.name).toBe("Code of an item");
  expect(resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "fr").types[0]?.codeAccount?.name).toBe(
    "Code of an item",
  );
});

test("Code account messages resolve one request locale and contain every translation", () => {
  expect(codeMessages.check()).toEqual([]);
  expect(codeMessages.resolve(["de-AT"]).t.accountName({ title: "Werkstatt" })).toBe("Code von Werkstatt");
  expect(codeMessages.resolve(["fr"]).t.accountName({ title: "Workshop" })).toBe("Code of Workshop");
});
