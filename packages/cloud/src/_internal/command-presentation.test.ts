import { expect, test } from "bun:test";
import { z } from "zod";
import { defineCapabilities } from "../contracts/capabilities";
import { compileCapabilities, resolveCapabilityManifestPresentation } from "./capabilities";

test("catalog Command presentation translates keywords alongside title and description without changing the source", () => {
  const definitions = defineCapabilities({
    protocolVersion: 2,
    commands: {
      "task.compose": {
        title: "New task",
        description: "Open a task form.",
        keywords: ["todo", "task"],
        input: z.object({}).strict(),
        path: "/app/spaces",
      },
    },
    presentation: {
      baseLocale: "en",
      translations: {
        de: {
          commands: {
            "task.compose": { title: "Neue Aufgabe", description: "Ein Aufgabenformular öffnen.", keywords: ["Aufgabe", "todo"] },
          },
        },
      },
    },
  });
  const compiled = compileCapabilities("spaces", definitions);
  expect(resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "de-CH").commands[0]).toMatchObject({
    title: "Neue Aufgabe",
    description: "Ein Aufgabenformular öffnen.",
    keywords: ["Aufgabe", "todo"],
  });
  expect(compiled.manifest.commands[0]?.keywords).toEqual(["todo", "task"]);
  expect(() =>
    compileCapabilities("spaces", {
      ...definitions,
      presentation: {
        baseLocale: "en",
        translations: {
          de: { commands: { "task.compose": { keywords: ["x".repeat(121)] } } },
        },
      },
    }),
  ).toThrow();
});
