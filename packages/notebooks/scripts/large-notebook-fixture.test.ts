import { describe, expect, test } from "bun:test";
import { HELP } from "./large-notebook";
import { buildFixtureTree, FIXTURE_SHAPES, type FixtureShape, renderFixtureMarkdown } from "./large-notebook-fixture";

describe("large-notebook fixture", () => {
  test.each(Object.keys(FIXTURE_SHAPES) as FixtureShape[])("%s has its page count, parents before children and links back", (shape) => {
    const tree = buildFixtureTree(shape);
    expect(tree).toHaveLength(FIXTURE_SHAPES[shape].notes);
    for (const note of tree) {
      if (note.parent !== null) expect(note.parent).toBeLessThan(note.index);
      for (const target of note.links) expect(target).toBeLessThan(note.index);
    }
  });

  test("medium keeps the folder sizes of the reported notebook", () => {
    const tree = buildFixtureTree("medium");
    const children = new Map<number, number>();
    for (const note of tree) if (note.parent !== null) children.set(note.parent, (children.get(note.parent) ?? 0) + 1);
    expect(tree.filter((note) => note.parent === null)).toHaveLength(17);
    expect([...children.values()].sort((a, b) => b - a)).toEqual([362, 246, 175, 162, 155, 94, 57, 39]);
  });

  test("large has deep levels, a 5,000-page folder and links", () => {
    const tree = buildFixtureTree("large");
    const depth = (index: number): number => (tree[index]!.parent === null ? 0 : 1 + depth(tree[index]!.parent!));
    const children = new Map<number, number>();
    for (const note of tree) if (note.parent !== null) children.set(note.parent, (children.get(note.parent) ?? 0) + 1);
    expect(Math.max(...tree.map((note) => depth(note.index)))).toBe(5);
    expect(Math.max(...children.values())).toBe(5000);
    expect(tree.reduce((sum, note) => sum + note.links.length, 0)).toBeGreaterThan(20_000);
  });

  test("the same seed renders the same Markdown with links, blocks, tables and images", () => {
    const render = () =>
      buildFixtureTree("medium").map((note) => renderFixtureMarkdown(note, { shortIdOf: () => "Abc123", imageId: "Img123" }));
    const pages = render();
    expect(render()).toEqual(pages);
    const all = pages.join("\n");
    for (const part of ["note://Abc123", "attach://Img123", ":::query", ":::toc", "| Item | Owner | Status |"]) expect(all).toContain(part);
  });

  test("the benchmark script documents its commands", () => {
    expect(HELP).toContain("seed");
    expect(HELP).toContain("measure");
  });
});
