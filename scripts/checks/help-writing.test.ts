import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { checkHelpSource, formatBaseline, parseGlossary, rule, sentences, wordCount } from "./help-writing";

const glossary = [
  "| English | German | Meaning | Not in English | Not in German |",
  "| --- | --- | --- | --- | --- |",
  "| access | Zugriff | What someone can do. | `permissions`, `read access` | `Berechtigung*`, `Rechte` |",
  "| choose | wählen | Activate a control. | `click*` | `klick*` |",
].join("\n");
const terms = parseGlossary(glossary);

const check = (path: string, lines: string[]) =>
  checkHelpSource(path, lines.join("\n"), terms).map((finding) => `${finding.line} ${finding.key.split(" | ").slice(1).join(" ")}`);

test("reads the avoid columns of every glossary table and ignores other tables", () => {
  expect(
    parseGlossary(`${glossary}\n\n| Term | Meaning |\n| --- | --- |\n| \`ignored\` | x |`).map((term) => `${term.locale}:${term.text}`),
  ).toEqual(["en:permissions", "en:read access", "de:Berechtigung*", "de:Rechte", "en:click*", "de:klick*"]);
});

test("the real glossary gives every concept an English and a German term", async () => {
  const source = await readFile(resolve(import.meta.dir, "../../docs-site/docs/en/reference/glossary.md"), "utf8");
  const parsed = parseGlossary(source);
  expect(parsed.filter((term) => term.locale === "en").length).toBeGreaterThan(10);
  expect(parsed.filter((term) => term.locale === "de").length).toBeGreaterThan(10);
  expect(parsed.every((term) => term.preferred && term.preferred !== "—")).toBe(true);
});

test("counts words in step sentences without splitting abbreviations", () => {
  expect(sentences("Open **Settings**, e.g. from the menu. Choose `Save`. Done!")).toEqual([
    "Open **Settings**, e.g. from the menu.",
    "Choose `Save`.",
    "Done!",
  ]);
  expect(sentences("Wähle z. B. eine Liste. Fertig.")).toEqual(["Wähle z. B. eine Liste.", "Fertig."]);
  expect(sentences('It says "Saved." Choose **Close** (or press Esc.) Done.')).toEqual([
    'It says "Saved."',
    "Choose **Close** (or press Esc.)",
    "Done.",
  ]);
  expect(sentences("Er meldet „Gespeichert.“ Wähle **Schließen**.")).toEqual(["Er meldet „Gespeichert.“", "Wähle **Schließen**."]);
  expect(wordCount("Choose **Save changes** — then wait.")).toBe(5);
});

test("flags only step sentences above the limit, including wrapped step lines", () => {
  const long = "Open the settings dialog from the sidebar and choose the tab that contains the people and groups who share this Space.";
  expect(
    check("packages/demo/src/help/documents/en/demo.help.md", [
      "---",
      "id: demo",
      "title: Demo",
      "---",
      "",
      long,
      "",
      `- ${long}`,
      "",
      ":::steps",
      "1. Open **Space settings**.",
      "2. Open the settings dialog from the sidebar and choose the tab that",
      "   contains the people and groups who share this Space.",
      `3. ${long.replace("Space.", "Space")}. Then choose **Save**.`,
      ":::",
    ]),
  ).toEqual(["12 step Open the settings dialog from the sidebar and", "14 step Open the settings dialog from the sidebar and"]);
});

test("counts an indented paragraph after a blank line as part of the step", () => {
  const long = "Then open the settings dialog from the sidebar and choose the tab that contains the people and groups who share it.";
  expect(
    check("packages/demo/src/help/documents/en/demo.help.md", [
      "1. Open **Space settings**.",
      "",
      `   ${long}`,
      "2. Choose **Save**.",
      "",
      long,
    ]),
  ).toEqual(["1 step Then open the settings dialog from the sidebar"]);
});

test("flags glossary synonyms in prose, link text, titles, and callout titles but not in labels, code, or link targets", () => {
  expect(
    check("packages/demo/src/help/documents/en/demo.help.md", [
      "---",
      "title: Permissions",
      "description: Give read access.",
      "---",
      "",
      '## Check permissions {icon="lock"}',
      "",
      "Click **Permissions** to see `permissions` in [the permissions page](/permissions).",
      "Double-click a row.",
      "Choose **Manage",
      "permissions** first.",
      "",
      "```text",
      "permissions click",
      "```",
      ":::warning Permissions change at once",
      ":::",
    ]),
  ).toEqual([
    "2 term permissions",
    "3 term read access",
    "6 term permissions",
    "8 term permissions",
    "8 term click*",
    "16 term permissions",
  ]);
});

test("matches terms across wrapped lines of a paragraph but not across blocks", () => {
  expect(
    check("packages/demo/src/help/documents/en/demo.help.md", [
      "---",
      "description: >",
      "  Check the",
      "  permissions.",
      "---",
      "Run `cld demo click",
      "permissions` here. People with read",
      "access see it.",
      "- **Bold permissions",
      "",
      "  text** and permissions.",
      "Choose **a *permissions* label**. Check permissions.",
      "# Read",
      "access",
    ]),
  ).toEqual(["4 term permissions", "7 term read access", "9 term permissions", "11 term permissions", "12 term permissions"]);
});

test("uses the German terms in German articles and respects capitalized terms", () => {
  expect(
    check("packages/demo/src/help/documents/de/demo.help.md", [
      "Prüfe die Berechtigungen. Klicke auf **Klicken**.",
      "Die rechte Spalte zeigt Rechte. Ein Doppelklick öffnet sie. Prüfe die permissions.",
    ]),
  ).toEqual(["1 term Berechtigung*", "1 term klick*", "2 term Rechte"]);
});

const workspace = async (help: string, baseline?: string[]) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-help-writing-"));
  const files: Record<string, string> = {
    "docs-site/docs/en/reference/glossary.md": glossary,
    "packages/demo/src/help/documents/en/demo.help.md": help,
  };
  if (baseline) files["scripts/checks/help-writing.baseline"] = formatBaseline(baseline);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
  const run = async (fix = false) =>
    (await rule.run({ workspaceRoot: root, fix, flags: new Set() })).map(
      (finding) => `${relative(root, finding.file ?? "")}${finding.line ? `:${finding.line}` : ""}`,
    );
  return { root, run };
};

const article = "packages/demo/src/help/documents/en/demo.help.md";
const baselinePath = "scripts/checks/help-writing.baseline";

test("baselined findings pass, new findings fail, and the baseline only shrinks", async () => {
  const known = [`${article} | term | permissions`, `${article} | term | permissions`, `${article} | term | click*`];
  const { root, run } = await workspace("Check permissions.\nCheck permissions.\nClick here.\n", known);
  try {
    expect(await run()).toEqual([]);

    await writeFile(join(root, article), "Check permissions.\nCheck permissions.\nClick here.\nCheck permissions.\n");
    expect(await run()).toEqual([`${article}:4`]);

    await writeFile(join(root, article), "Check access.\nCheck permissions.\nChoose here.\nCheck permissions.\n");
    expect(await run()).toEqual([baselinePath]);

    await writeFile(join(root, article), "Check access.\nCheck permissions.\nChoose here.\n");
    expect(await run()).toEqual([baselinePath, baselinePath]);
    expect(await run(true)).toEqual([]);
    expect((await readFile(join(root, baselinePath), "utf8")).split("\n").filter((line) => line.startsWith("packages/"))).toEqual([
      `${article} | term | permissions`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("without a baseline every finding fails", async () => {
  const { root, run } = await workspace("Check permissions.\n");
  try {
    expect(await run()).toEqual([`${article}:1`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
