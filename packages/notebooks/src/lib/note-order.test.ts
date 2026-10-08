import { describe, expect, test } from "bun:test";
import { compareNoteOrder, isHandOrdered, sortNoteLevels } from "./note-order";

type Node = { id: string; title: string; position: number; children: Node[] };
const note = (id: string, title: string, position = 0, children: Node[] = []): Node => ({ id, title, position, children });
const titles = (nodes: Node[], depth = 0): string[] =>
  nodes.flatMap((node) => [`${"  ".repeat(depth)}${node.title}`, ...titles(node.children, depth + 1)]);
const sort = (nodes: Node[], locale = "en") =>
  sortNoteLevels(
    nodes,
    compareNoteOrder(locale, (node: Node) => node.id),
  );

describe("notebook order", () => {
  test("a level nobody arranged reads by title, with numbers as numbers", () => {
    const level = [note("n1", "Chapter 10"), note("n2", "chapter 2"), note("n3", " Appendix"), note("n4", "Chapter 1")];
    expect(titles(sort(level))).toEqual([" Appendix", "Chapter 1", "chapter 2", "Chapter 10"]);
    expect(isHandOrdered(level)).toBe(false);
  });

  test("a level arranged by hand follows its positions, every level on its own", () => {
    const tree = [
      note("n1", "Appendix", 3),
      note("n2", "Welcome", 1, [note("n4", "Zebra"), note("n5", "Apple")]),
      note("n3", "Guides", 2, [note("n6", "Setup", 2), note("n7", "Overview", 1)]),
    ];
    expect(titles(sort(tree))).toEqual(["Welcome", "  Apple", "  Zebra", "Guides", "  Overview", "  Setup", "Appendix"]);
    expect(isHandOrdered(tree)).toBe(true);
  });

  test("equal titles fall back to the short ID, so every surface agrees", () => {
    expect(sort([note("n3", "Notes"), note("n1", " Notes "), note("n2", "Notes")]).map((node) => node.id)).toEqual(["n1", "n2", "n3"]);
  });

  test("letters sort as the reader's language expects and the input stays untouched", () => {
    const level = [note("n1", "Zebra"), note("n2", "Äpfel"), note("n3", "Ofen")];
    expect(titles(sort(level, "de"))).toEqual(["Äpfel", "Ofen", "Zebra"]);
    expect(titles(sort(level, "sv"))).toEqual(["Ofen", "Zebra", "Äpfel"]);
    expect(level.map((node) => node.id)).toEqual(["n1", "n2", "n3"]);
  });
});
