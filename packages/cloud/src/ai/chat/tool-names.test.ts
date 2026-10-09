import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODE_RUNTIME_TOOL_NAMES } from "../browser-code-contracts";
import { CODE_SOURCE_TOOLS } from "../code-source-contracts";
import { displayToolName } from "./message-utils";
import { aiBuiltinToolName, checkAiToolNames } from "./tool-names";

const aiSource = resolve(import.meta.dir, "..");

/** Every tool Cloud ships: each `defineAiTool({ name: "…" })` in the AI sources, plus the Studio tools named by table. */
const builtinToolNames = (): string[] => {
  const files = readdirSync(aiSource, { recursive: true, encoding: "utf8" }).filter(
    (file) => /\.tsx?$/.test(file) && !/\.(test|eval)\.tsx?$/.test(file),
  );
  const defined = files.flatMap((file) =>
    [...readFileSync(join(aiSource, file), "utf8").matchAll(/defineAiTool(?:<[^>]*>)?\(\{\s*name:\s*"([a-z0-9_]+)"/g)].map(
      (match) => match[1]!,
    ),
  );
  return [...new Set([...defined, ...CODE_RUNTIME_TOOL_NAMES, ...Object.keys(CODE_SOURCE_TOOLS)])].sort();
};

test("tool names have the same keys in every locale", () => {
  expect(checkAiToolNames()).toEqual([]);
});

test("every built-in tool has a name in English and German", () => {
  const names = builtinToolNames();
  expect(names).toEqual(expect.arrayContaining(["code_check", "view_image", "code_write", "memory", "search_tools"]));
  const missing = names.filter((name) => !aiBuiltinToolName(name, "en") || !aiBuiltinToolName(name, "de"));
  expect(missing).toEqual([]);
});

test("shows built-in tools by their localized name and other tools by their name in words", () => {
  expect(displayToolName("code_check", "en")).toBe("App check");
  expect(displayToolName("code_check", "de")).toBe("App-Prüfung");
  expect(displayToolName("view_image", "de-AT")).toBe("Bild ansehen");
  expect(displayToolName("cloud_card", "de")).toBe("Karte");
  expect(displayToolName("custom_tool", "de")).toBe("Custom tool");
});
