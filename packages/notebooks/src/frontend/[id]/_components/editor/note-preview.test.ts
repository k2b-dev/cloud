import { expect, test } from "bun:test";
import { LIGATURES } from "../../../../lib/ligatures";
import { type NotePreviewPart, notePreviewLines } from "./note-preview";

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
