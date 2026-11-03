import { expect, test } from "bun:test";
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
