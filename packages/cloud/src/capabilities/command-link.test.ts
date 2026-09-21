import { expect, test } from "bun:test";
import { z } from "zod";
import { compileCapabilities, parseCapabilityManifest, resolveCapabilityManifestPresentation } from "../_internal/capabilities";
import { CommandPathSchema, clearCommand, commandPath, readCommand } from "../contracts/commands";
import { resolveCommandLink } from "./command-link";

const compiled = compileCapabilities("demo", {
  protocolVersion: 2,
  commands: {
    compose: {
      title: "Compose",
      description: "Open a form.",
      path: "/app/demo",
      input: z.object({ id: z.string().optional().describe("Optional source ID.") }).strict(),
    },
  },
  presentation: { baseLocale: "en", translations: { de: { commands: { compose: { title: "Verfassen" } } } } },
});

test("Command compile/registry contract is a clean protocol cut with localized presentation", () => {
  expect(compiled.manifest.commands).toHaveLength(1);
  expect(parseCapabilityManifest(compiled.manifest, "demo").commands).toHaveLength(1);
  expect(resolveCapabilityManifestPresentation(compiled.manifest, compiled.presentation, "de").commands[0]?.title).toBe("Verfassen");
  expect(() => parseCapabilityManifest({ ...compiled.manifest, protocolVersion: 1 }, "demo")).toThrow();
});
test("resolution uses configured public origin, validates input, and never calls app code", () => {
  const command = compiled.manifest.commands[0]!;
  const { href } = resolveCommandLink(
    "demo",
    command,
    { id: "AbCd12" },
    { returnTo: "/app/contacts?contact=AbCd12" },
    "https://cloud.example.test",
  );
  const url = new URL(href);
  expect(url.origin).toBe("https://cloud.example.test");
  expect(readCommand(url)).toEqual({ id: "demo.compose", input: { id: "AbCd12" }, options: { returnTo: "/app/contacts?contact=AbCd12" } });
  expect(clearCommand(url)).toBe("/app/demo");
  expect(() => resolveCommandLink("demo", command, { injected: true }, {}, "https://cloud.example.test")).toThrow();
});
test("return destinations reject off-site URLs and browser URL normalization tricks", () => {
  for (const value of ["https://evil.test", "//evil.test", "/\\evil.test", "/\n/evil.test", "javascript:alert(1)"]) {
    expect(CommandPathSchema.safeParse(value).success).toBe(false);
  }
  expect(CommandPathSchema.safeParse("/app/contacts?contact=AbCd12#details").success).toBe(true);
  expect(() => commandPath("/app/demo", "demo.compose", { text: "x".repeat(9000) })).toThrow();
});
