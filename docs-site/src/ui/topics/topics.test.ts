import { describe, expect, test } from "bun:test";
import { registerSsrTestPlugin } from "../../../../packages/ui/test/ssr-test-plugin";

// The topic pages of the UI section: every recipe file is registered, every finished topic keeps the fixed shape, and
// the Markdown twin that search and read_doc return carries the recipe's code and the generated props.
registerSsrTestPlugin(await import("../../ssr"));
const { recipeSource, v2Props } = await import("./build-results");
const { firstSentence } = await import("./build-time");
const { recipeNames, recipeStates } = await import("./recipes");
const { parseTopic, propsMarkdown, topicMarkdown, topicShapeProblems } = await import("./topic-markdown");
const { topics } = await import("./topics");
const { uiCatalogEntries } = await import("../catalog");
const { v1Pointer } = await import("./v1-pointers");

describe("recipes", () => {
  test("every recipe file of the skill k2b-ui is one entry of recipes.ts", () => {
    const registered: string[] = [...recipeNames];
    expect(registered.sort()).toEqual(Object.keys(recipeSource).sort());
  });

  test("every recipe stands on the page Whole screens", async () => {
    const screens = await Bun.file(new URL("./screens.md", import.meta.url)).text();
    const shown = [...screens.matchAll(/<Example recipe="([^"]+)"/g)].map((match) => match[1]);
    const registered: string[] = [...recipeNames];
    expect([...new Set(shown)].sort()).toEqual(registered.sort());
  });

  test("every recipe names what it is in its first line", () => {
    for (const name of recipeNames) expect(recipeSource[name]).toMatch(/^\/\/ Recipe: /);
  });

  test("the recipes of topic 2 offer their states", () => {
    expect(Object.keys(recipeStates("table"))).toEqual(["empty", "loading", "failed"]);
    expect(Object.keys(recipeStates("list-detail"))).toEqual(["closed", "loading"]);
  });
});

describe("topic pages", () => {
  test("there are the nine topics of the concept, in order", () => {
    expect(topics.map((topic) => topic.slug)).toEqual([
      "frame",
      "lists-and-tables",
      "filter-sort-group",
      "record-and-detail",
      "forms-and-input",
      "actions-and-menus",
      "dialogs-and-overlays",
      "states-and-notices",
      "content",
    ]);
  });

  for (const topic of topics)
    test(`${topic.slug} keeps the shape of a topic page`, () => {
      expect(topicShapeProblems(topic.parsed)).toEqual([]);
      expect(topic.summary.length).toBeGreaterThan(10);
      expect(topic.parts.length).toBeGreaterThan(0);
    });

  test("Lists and tables is finished and is the reference page", () => {
    const topic = topics.find((candidate) => candidate.slug === "lists-and-tables");
    expect(topic?.parsed.front.status).toBeUndefined();
    expect(topic?.parts).toEqual(["List", "Row", "Table", "StatusRow", "Pane.Split", "Empty · Loading · Failed"]);
  });

  test("a wrong shape is named", () => {
    const parsed = parseTopic("# Broken\n\nLead.\n\n## Parts\n\n### List\n\n## A table\n\nText.\n");
    expect(topicShapeProblems(parsed)).toEqual(
      expect.arrayContaining([
        '"A table" stands after a later section; the order is example, choice, parts, missing, rules, next',
        "no live example: an example section needs an <Example recipe=… />",
        "part List has no line that says what it is",
      ]),
    );
  });

  test("a placeholder that names no recipe or no part fails the build", () => {
    expect(() => parseTopic('# T\n\n## A\n\n<Example recipe="nothing" />\n')).toThrow('no recipe "nothing"');
    expect(() => parseTopic('# T\n\n## Parts\n\n### X\n\nLine.\n\n<Props of="Tabel" />\n')).toThrow("no part or type Tabel");
  });

  test("a placeholder inside a code block stays text", () => {
    const parsed = parseTopic('# T\n\nLead.\n\n## A\n\n```md\n<Example recipe="nothing" />\n```\n');
    expect(parsed.sections[0]?.blocks).toEqual([{ kind: "markdown", text: '```md\n<Example recipe="nothing" />\n```' }]);
  });
});

describe("the Markdown twin for search and read_doc", () => {
  const twin = topics.find((topic) => topic.slug === "lists-and-tables")?.markdown ?? "";

  test("replaces every placeholder", () => {
    expect(twin).not.toMatch(/^<(Example|Props)\b/m);
    expect(twin).not.toStartWith("---");
    expect(twin).toStartWith("\n# Lists and tables");
  });

  test("carries each recipe's path, states and whole file", () => {
    expect(twin).toContain("`packages/ui/skills/k2b-ui/recipes/table.tsx` (states: empty, loading, failed)");
    expect(twin).toContain(`\`\`\`tsx\n${recipeSource.table?.trimEnd()}\n\`\`\``);
    expect(twin).toContain("`packages/ui/skills/k2b-ui/recipes/list-detail.tsx` (states: closed, loading)");
  });

  test("carries the props as tables, with a group per variant", () => {
    expect(twin).toContain("#### `Table<T>` props");
    expect(twin).toContain("| `rows` (required) | `readonly T[]` | The rows. |");
    expect(twin).toContain("With `rowKey`:");
    expect(twin).toContain("| `rowKey` (required in this variant) | `(row: T) => string` | The stable key of a row. |");
    expect(twin).toContain("#### `Column<T>` props");
    expect(twin).toContain("#### `Pane.Split` props");
  });

  test("escapes the bars of union types inside table cells", () => {
    expect(twin).toContain('`"start" \\| "end"`');
  });

  test("a code fence in a recipe never ends the twin's code block", () => {
    expect(topicMarkdown('# T\n\nLead.\n\n## A\n\n<Example recipe="table" />\n')).toContain("```tsx\n");
  });
});

describe("generated props", () => {
  test("Table carries every prop with its TSDoc sentence", () => {
    const table = v2Props.Table;
    expect(table?.title).toBe("Table<T>");
    expect(table?.file).toBe("packages/ui/src/v2/content.tsx");
    expect(table?.rows.filter((row) => !row.description).map((row) => row.name)).toEqual([]);
    expect(table?.rows.slice(0, 2).every((row) => row.required)).toBe(true);
    expect(table?.groups.map((group) => group.title)).toEqual(["With `rowKey`"]);
  });

  test("a union of props shows its variants as alternatives, each required only within its variant", () => {
    const prose = v2Props.Prose;
    if (!prose) throw new Error("Prose has no generated props");
    expect(prose.rows).toEqual([]);
    expect(prose.groups.map((group) => group.title)).toEqual(["With `markdown`", "Or with `children`"]);
    const twin = propsMarkdown(prose);
    expect(twin).toContain("With `markdown`:");
    expect(twin).toContain("Or with `children`:");
    expect(twin).toContain("| `markdown` (required in this variant) |");
    expect(twin).not.toContain("(required) |");
  });

  test("a tuple type has places, not props", () => {
    expect(v2Props.RowLines).toBeUndefined();
    expect(v2Props.TwoActions).toBeUndefined();
  });

  test("the first sentence never ends inside a quote", () => {
    expect(firstSentence('What failed, such as "Nichts geladen. Die Ansicht bleibt." Then more.')).toBe(
      'What failed, such as "Nichts geladen. Die Ansicht bleibt."',
    );
    expect(firstSentence("One. Two.")).toBe("One.");
  });

  test("dotted parts and object types have props of their own", () => {
    expect(v2Props["Pane.Split"]?.kind).toBe("component");
    expect(v2Props.Column?.kind).toBe("type");
  });
});

describe("v1 pages", () => {
  test("each starts with a pointer to its v2 topic", () => {
    const hrefs = new Set(topics.map((topic) => topic.href));
    for (const entry of uiCatalogEntries) {
      const pointer = v1Pointer(entry);
      expect(pointer).toStartWith("> **v1 (existing).**");
      expect(hrefs.has(pointer.match(/\]\(([^)]+)\)/)?.[1] ?? "")).toBe(true);
    }
  });
});
