import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { frontMatterLength, LIGATURES } from "../../../../lib/ligatures";
import { type NotePreviewPart, notePreviewLines } from "./note-preview";

const repositoryRoot = resolve(import.meta.dir, "../../../../../../..");

const text = (parts: NotePreviewPart[]): string => parts.map((part) => (typeof part === "string" ? part : text(part.children))).join("");
const lines = (markdown: string, mode: "rich" | "source" = "rich") => notePreviewLines(markdown, mode).map((line) => text(line.parts));
const classes = (parts: NotePreviewPart[]): string[] =>
  parts.flatMap((part) => (typeof part === "string" ? [] : [part.className, ...classes(part.children)]));

test("headings keep the first line's marker and hide later opening marks plus one space", () => {
  expect(lines("# First\n\n## Second\n###  Third ###")).toEqual(["# First", "", "Second", " Third ###"]);
});
test("emphasis ranges include cursor zero; later strong, emphasis and strike marks hide", () => {
  for (const marker of ["**", "__", "*", "_", "~~"]) {
    expect(lines(`${marker}first${marker}\n\nText ${marker}later${marker}`)).toEqual([`${marker}first${marker}`, "", "Text later"]);
  }
  const parts = notePreviewLines("Text **bold** *soft* ~~gone~~", "rich")[0]!.parts;
  expect(classes(parts)).toEqual(
    expect.arrayContaining(["notebook-note-preview__strong", "notebook-note-preview__emphasis", "notebook-note-preview__strike"]),
  );
});
test("inline code keeps its backticks; fenced and indented code use the block font", () => {
  const input = "Use `#tag ->`\n\n```js\n#tag -> **literal**\n```\n\n    literal";
  expect(lines(input)).toEqual(input.split("\n"));
  expect(classes(notePreviewLines(input, "rich")[0]!.parts)).toContain("notebook-note-preview__code");
  expect(classes(notePreviewLines(input, "rich")[3]!.parts)).toContain("notebook-note-preview__code notebook-note-preview__code-block");
  expect(classes(notePreviewLines(input, "rich")[6]!.parts)).toContain("notebook-note-preview__code notebook-note-preview__code-block");
});
test("the heading wraps code and emphasis spans so em sizes inherit the heading", () => {
  const parts = notePreviewLines("# Title `code` **bold**", "rich")[0]!.parts;
  expect(parts).toHaveLength(1);
  const heading = parts[0];
  if (typeof heading === "string" || !heading) throw new Error("Missing heading span");
  expect(heading.className).toBe("notebook-note-preview__heading-1");
  expect(classes(heading.children)).toContain("notebook-note-preview__code");
  expect(classes(heading.children)).toContain("notebook-note-preview__strong");
});
test("setext headings style both text and marker lines without hiding the underline", () => {
  const result = notePreviewLines("Title\n=====\n\nSubtitle\n--------", "rich");
  expect(result.map((line) => text(line.parts))).toEqual(["Title", "=====", "", "Subtitle", "--------"]);
  expect(classes(result[0]!.parts)).toContain("notebook-note-preview__heading-1");
  expect(classes(result[4]!.parts)).toContain("notebook-note-preview__heading-2");
});
test("source mode returns every raw line without styles or cuts", () => {
  const input = "# Title\n**bold** #tag\n- [x] task\n<script>alert(1)</script>\n";
  expect(lines(input, "source")).toEqual(input.split("\n"));
  expect(notePreviewLines(input, "source").flatMap((line) => classes(line.parts))).toEqual([]);
});
test("empty text is the editor's one empty line and line separators normalize", () => {
  expect(notePreviewLines("", "rich")).toEqual([{ parts: [] }]);
  expect(notePreviewLines("", "source")).toEqual([{ parts: [] }]);
  expect(lines("one\r\ntwo\rthree")).toEqual(["one", "two", "three"]);
});

const cuts = [
  ["list", "- item"],
  ["task", "- [x] task"],
  ["link", "[label](https://example.test)"],
  ["image", "![alt](/image.png)"],
  ["autolink", "<https://example.test>"],
  ["bare URL", "https://example.test"],
  ["quote", "> quote"],
  ["table", "| A | B |\n| --- | --- |\n| 1 | 2 |"],
  ["rule", "---"],
  ["HTML", "<script>alert(1)</script>"],
  ["escape", "a \\* literal"],
  ["entity", "a &amp; b"],
  ["tag", "a #tag/sub"],
  ["mark", "a ==marked=="],
  ["sub", "H~2~O"],
  ["sup", "x^2^"],
  ["inline math", "a $x$"],
  ["inline bracket math", "a \\(x\\)"],
  ["block math", "$$x\ny$$"],
  ["block bracket math", "\\[x\\]"],
  ["operator ligature", "a -> b"],
  ["word ligature", "a (c) b"],
  ["suffix ligature", "Cloud(tm)"],
  ["dots ligature", "wait..."],
  ["spaced ligature", "a -- b"],
  ["info", ":::info\nnotice\n:::"],
  ["query", ":::query\nsource: notes\n:::"],
  ["toc", ":::toc\n:::"],
  ["data", ":::data\nx: 1\n:::"],
  ["named block", "@profile\n:::data\nx: 1\n:::"],
  ["mermaid fence", "```mermaid\ngraph TD\n```"],
  ["math fence", "~~~math\nx\n~~~"],
  ["special character", "a\u0001b"],
  ["zero width", "a\u200bb"],
] as const;
test.each(cuts)("cuts immediately before %s", (_name, trigger) => {
  expect(lines(`Safe prose\n\n${trigger}\n\nHidden tail`)).toEqual(["Safe prose", ""]);
});
test("front matter cuts at the beginning", () => {
  expect(lines("---\ntitle: Plan\n---\nProse")).toEqual([]);
});
test("mark and sub/sup also cut inside code because those editor extensions scan code", () => {
  for (const syntax of ["==mark==", "~sub~", "^sup^"]) {
    expect(lines(`Safe\n\n\`literal ${syntax}\``)).toEqual(["Safe", ""]);
  }
});
test("parses the whole long note without truncating", () => {
  const markdown = Array.from({ length: 2000 }, (_, index) => `Paragraph ${index}`).join("\n\n");
  expect(lines(markdown).at(-1)).toBe("Paragraph 1999");
});

test.each([...LIGATURES])("cuts before display ligature $source", ({ source }) => {
  expect(lines(`Safe prose\n\na ${source} b\nHidden tail`)).toEqual(["Safe prose", ""]);
});

const equivalenceFixtures = [
  "# First\n\n## Second\n###  Third ###",
  ...["**", "__", "*", "_", "~~"].map((marker) => `${marker}first${marker}\n\nText ${marker}later${marker}`),
  "Text **bold** *soft* ~~gone~~",
  "Use `#tag ->`\n\n```js\n#tag -> **literal**\n```\n\n    literal",
  "# Title `code` **bold**",
  "Title\n=====\n\nSubtitle\n--------",
  "# Title\n**bold** #tag\n- [x] task\n<script>alert(1)</script>\n",
  "",
  "one\r\ntwo\rthree",
  ...cuts.map(([, trigger]) => `Safe prose\n\n${trigger}\n\nHidden tail`),
  "---\ntitle: Plan\n---\nProse",
  ...["==mark==", "~sub~", "^sup^"].map((syntax) => `Safe\n\n\`literal ${syntax}\``),
  Array.from({ length: 2000 }, (_, index) => `Paragraph ${index}`).join("\n\n"),
  ...LIGATURES.map(({ source }) => `Safe prose\n\na ${source} b\nHidden tail`),
  "Text **bold\non two lines**\n\nTail",
  "Safe\n\nTitle\n=====\n\nTail",
  "Safe\n\n| A | B |\n| --- | --- |\n| 1 | 2 |",
  "Safe\n\n```js\n#tag\n\n->\n\n```\n\nTail",
  "Safe\n\n$$\n\na\n\n$$\n\nTail",
  "$$\n\na\n\n$$",
  "==mark\n\nacross==",
  "Safe\n\n<!-- comment\n\nmore comment\n-->\n\nTail",
  "Safe\n\n- item\n\n  continued\n\nTail",
  "Safe\n \t\nText ***nested*** and **outer *inner* outer**\n\nTail",
  "# Title ***nested*** `code` ~~gone~~",
  "Safe\n\n[foo]\n\n[foo]: /target",
  "Prose " + "**bold** ".repeat(3),
  // A line of other white space is no blank line: the setext heading spans it.
  "Line A\nTitle #tag\n\u00a0\n===\n\nTail",
  // Block math in code that a window cuts short.
  "```\n$$\n\na\n\n$$\n```\n\nTail",
];

const expectEquivalent = (markdown: string) => {
  const full = notePreviewLines(markdown, "rich", Number.POSITIVE_INFINITY);
  for (const window of [1, 64, 1024]) expect(notePreviewLines(markdown, "rich", window)).toEqual(full);
  expect(notePreviewLines(markdown, "rich")).toEqual(full);
};

test("equivalence of tiny and full parse windows for fixtures and block boundaries", () => {
  for (const markdown of equivalenceFixtures) expectEquivalent(markdown);
});

test("equivalence of tiny and full parse windows for every docs Markdown file and long prefixes", async () => {
  const paths = Array.from(new Bun.Glob("docs-site/docs/en/**/*.md").scanSync({ cwd: repositoryRoot })).sort();
  expect(paths.length).toBeGreaterThan(0);
  let longest = "";
  for (const path of paths) {
    const markdown = await Bun.file(resolve(repositoryRoot, path)).text();
    expectEquivalent(markdown);
    const body = markdown.slice(frontMatterLength(markdown));
    expectEquivalent(body);
    if (body.length > longest.length) longest = body;
  }
  expect(longest.length).toBeGreaterThan(16 * 1024);
  for (const end of [1, 100, 1024, 16 * 1024 - 1, 16 * 1024, 16 * 1024 + 1, Math.floor(longest.length / 2), longest.length - 1]) {
    expectEquivalent(longest.slice(0, end));
  }
});

test("many styled spans stay within the SSR render budget and keep their parts", () => {
  expect(notePreviewLines("Prose " + "**bold** ".repeat(3), "rich")).toEqual([
    {
      parts: [
        "Prose ",
        { className: "notebook-note-preview__strong", children: ["bold"] },
        " ",
        { className: "notebook-note-preview__strong", children: ["bold"] },
        " ",
        { className: "notebook-note-preview__strong", children: ["bold"] },
        " ",
      ],
    },
  ]);
  const markdown = "Prose " + "**bold** ".repeat(16000);
  const start = performance.now();
  const result = notePreviewLines(markdown, "rich");
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(1000);
  expect(result).toHaveLength(1);
  expect(text(result[0]!.parts)).toBe("Prose " + "bold ".repeat(16000));
});

test("a long note that starts with front matter has no preview", () => {
  const prose = "Ordinary prose.\n\n";
  expect(notePreviewLines(`---\ntitle: Plan\n---\n${prose.repeat(40_000)}`, "rich")).toEqual([]);
});
