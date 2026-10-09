import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODE_RUNTIME_TOOL_NAMES } from "../browser-code-contracts";
import { CODE_SOURCE_TOOLS } from "../code-source-contracts";
import { displayToolName } from "./message-utils";
import { aiBuiltinToolName, checkAiToolNames } from "./tool-names";

const aiSource = resolve(import.meta.dir, "..");

/** Names that come from elsewhere: Studio source tools from CODE_SOURCE_TOOLS, capability tools with their app's own title. */
const DYNAMIC_NAMES = [/^\{\s*name,/, /^\{\s*name: entry\.providerName,/];

/**
 * Every tool Cloud ships: each `defineAiTool({ name: "…" })` in the AI sources, plus the Studio tools named by table. A
 * call whose name this cannot read is listed in `unread`, so a tool defined another way fails the test instead of
 * slipping past it.
 */
const builtinTools = () => {
  const files = readdirSync(aiSource, { recursive: true, encoding: "utf8" }).filter(
    (file) => /\.tsx?$/.test(file) && !/\.(test|eval)\.tsx?$/.test(file),
  );
  const unread: string[] = [];
  const defined = files.flatMap((file) =>
    [...readFileSync(join(aiSource, file), "utf8").matchAll(/defineAiTool(?:<[^>]*>)?\(([^]{0,120})/g)].flatMap((match) => {
      const config = match[1]!;
      const name = /^\{\s*name:\s*"([a-z0-9_]+)",/.exec(config)?.[1];
      if (name) return [name];
      if (!DYNAMIC_NAMES.some((pattern) => pattern.test(config))) unread.push(`${file}: ${config.split("\n", 2).join(" ").trim()}`);
      return [];
    }),
  );
  return { names: [...new Set([...defined, ...CODE_RUNTIME_TOOL_NAMES, ...Object.keys(CODE_SOURCE_TOOLS)])].sort(), unread };
};

test("tool names have the same keys in every locale", () => {
  expect(checkAiToolNames()).toEqual([]);
});

test("every built-in tool has a name in English and German", () => {
  const { names, unread } = builtinTools();
  expect(unread).toEqual([]);
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
