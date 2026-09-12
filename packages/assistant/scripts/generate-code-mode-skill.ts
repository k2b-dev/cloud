import { parseAiSkillMarkdown } from "@k2b/cloud/ai/browser";
import { readdir } from "node:fs/promises";

const directory = new URL("../skills/code-mode/", import.meta.url);
const document = parseAiSkillMarkdown(await Bun.file(new URL("SKILL.md", directory)).text());
const names = (await readdir(new URL("references/", directory))).filter((name) => name.endsWith(".md")).sort();
const references = await Promise.all(names.map(async (name) => ({
  path: `references/${name}`,
  content: await Bun.file(new URL(`references/${name}`, directory)).text(),
})));
// Local Markdown links remain readable in the checkout; installed skills use
// the existing virtual skill filesystem exposed to Assistant.
const instructions = document.instructions.replace(/\]\(references\/([^\s)]+)\)/g,
  `](/skills/${document.name}/references/$1)`);
const template = { key: "assistant:code-mode", version: 22, ...document, instructions, references };
const output = `// Generated from packages/assistant/skills/code-mode. Do not edit here.\n// Regenerate: bun packages/assistant/scripts/generate-code-mode-skill.ts\nimport type { AiSkillTemplate } from "./skills";\n\nexport const ASSISTANT_CODE_MODE_SKILL = ${JSON.stringify(template, null, 2)} satisfies AiSkillTemplate;\n`;
const destination = new URL("../../cloud/src/ai/code-mode-skill.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (!(await Bun.file(destination).exists()) || await Bun.file(destination).text() !== output) {
    throw new Error("Code mode skill snapshot is stale. Run bun packages/assistant/scripts/generate-code-mode-skill.ts");
  }
} else {
  await Bun.write(destination, output);
}
