import { describe, expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { parseNotebookQueryBlocks, parseNotebookTocBlocks } from "../../../lib/query-blocks";
import { buildDataBlockTemplate } from "./data-block-template";
import { buildInfoBlockSnippet, infoBlockCompletionSource } from "./info-block-snippets";
import { markdownExtension } from "./markdown";

const stateFor = (doc: string) =>
  EditorState.create({
    doc,
    extensions: [markdownExtension()],
  });

describe("info block snippets", () => {
  test("offers data blocks for ::: directives", () => {
    const doc = ":::";
    const result = infoBlockCompletionSource(new CompletionContext(stateFor(doc), doc.length, true));
    const data = result?.options.find((option) => option.label === "data");

    expect(data?.detail).toBe("Referenceable data block");
    expect(typeof data?.apply).toBe("function");
  });

  test("data block template includes a reference handle", () => {
    expect(buildDataBlockTemplate()).toBe(`@ref
:::data
key: value
:::`);
  });

  test("localizes visible help without changing directive names or snippets", () => {
    const previousDocument = globalThis.document;
    Object.assign(globalThis, { document: { documentElement: { lang: "de-CH" } } });
    try {
      const doc = ":::";
      const result = infoBlockCompletionSource(new CompletionContext(stateFor(doc), doc.length, true));
      expect(result?.options.find((option) => option.label === "data")?.detail).toBe("Referenzierbarer Datenblock");
      expect(result?.options.map((option) => option.label)).toEqual([
        "note",
        "info",
        "success",
        "warning",
        "danger",
        "data",
        "query",
        "toc",
      ]);
      expect(result?.options.find((option) => option.label === "query")?.detail).toBe("Gefilterte Notizliste oder Tabelle");
      expect(result?.options.find((option) => option.label === "toc")?.detail).toBe("Inhaltsverzeichnis");
    } finally {
      Object.assign(globalThis, { document: previousDocument });
    }
  });

  test("query and TOC snippets conform to the shared parser", () => {
    const query = `:::${buildInfoBlockSnippet("query").replace("${0}", "")}`;
    const toc = `:::${buildInfoBlockSnippet("toc").replace("${0}", "")}`;
    expect(parseNotebookQueryBlocks(query).blocks).toHaveLength(1);
    expect(parseNotebookQueryBlocks(query).diagnostics).toEqual([]);
    expect(parseNotebookTocBlocks(toc).blocks).toHaveLength(1);
    expect(parseNotebookTocBlocks(toc).diagnostics).toEqual([]);
  });
});
