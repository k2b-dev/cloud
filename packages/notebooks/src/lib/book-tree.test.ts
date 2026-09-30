import { describe, expect, test } from "bun:test";
import { orderBookTree } from "./book-tree";

type Source = { id: string; title: string; children: Source[] };
const note = (id: string, title: string, children: Source[] = []): Source => ({ id, title, children });
const order = (nodes: Source[], homeId: string | null = null, locale = "en") =>
  orderBookTree(nodes, { id: (node) => node.id, homeId, locale });
/** Titles in reading order, sub-pages indented below their page. */
const outline = (nodes: ReturnType<typeof order>, depth = 0): string[] =>
  nodes.flatMap((node) => [`${"  ".repeat(depth)}${node.title}`, ...outline(node.children, depth + 1)]);

describe("Book reading order", () => {
  test("a start page at the top level comes first, the other pages follow by title", () => {
    const tree = [note("note01", "Appendix"), note("note02", "Glossary"), note("note03", "Welcome", [note("note04", "First steps")])];
    expect(outline(order(tree, "note03"))).toEqual(["Welcome", "  First steps", "Appendix", "Glossary"]);
    expect(outline(order(tree))).toEqual(["Appendix", "Glossary", "Welcome", "  First steps"]);
  });

  test("a start page below another page moves to the top with its sub-pages and leaves its parent", () => {
    const tree = [
      note("note01", "Appendix"),
      note("note02", "Guides", [
        note("note03", "Setup"),
        note("note04", "Overview", [note("note05", "Roadmap"), note("note06", "Audience")]),
      ]),
    ];
    expect(outline(order(tree, "note04"))).toEqual(["Overview", "  Audience", "  Roadmap", "Appendix", "Guides", "  Setup"]);
    expect(order(tree, "note04").map((node) => node.id)).toEqual(["note04", "note01", "note02"]);
  });

  test("a start page that is no longer in the notebook leaves the order by title", () => {
    expect(outline(order([note("note02", "Glossary"), note("note01", "Appendix")], "gone01"))).toEqual(["Appendix", "Glossary"]);
  });

  test("numbers in titles count as numbers at every level", () => {
    const tree = [
      note("note01", "Kapitel 10"),
      note("note02", "Kapitel 2", [note("note03", "Teil 12"), note("note04", "Teil 3")]),
      note("note05", "Kapitel 1"),
    ];
    expect(outline(order(tree, null, "de"))).toEqual(["Kapitel 1", "Kapitel 2", "  Teil 3", "  Teil 12", "Kapitel 10"]);
  });

  test("letters sort as the reader's language expects", () => {
    const tree = [note("note01", "Zebra"), note("note02", "Äpfel"), note("note03", "apfel"), note("note04", "Ofen"), note("note05", "Öl")];
    expect(outline(order(tree, null, "de"))).toEqual(["apfel", "Äpfel", "Ofen", "Öl", "Zebra"]);
    expect(outline(order(tree, null, "sv"))).toEqual(["apfel", "Ofen", "Zebra", "Äpfel", "Öl"]);
  });

  test("pages with the same title keep their incoming order and surrounding spaces do not matter", () => {
    const tree = [note("note03", "Notes"), note("note01", " Notes "), note("note02", "Notes"), note("note04", "  Agenda")];
    expect(order(tree).map((node) => node.id)).toEqual(["note04", "note03", "note01", "note02"]);
  });

  test("returns only the public reading fields", () => {
    const internal = [
      { id: "33333333-3333-4333-8333-333333333333", shortId: "note01", title: "Welcome", contentMd: "# Welcome", children: [] },
    ];
    expect(orderBookTree(internal, { id: (node) => node.shortId, homeId: null, locale: "en" })).toEqual([
      { id: "note01", title: "Welcome", children: [] },
    ]);
  });
});
