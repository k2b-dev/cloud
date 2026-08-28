import { describe, expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { buildDataBlockTemplate } from "./data-block-template";
import { infoBlockCompletionSource } from "./info-block-snippets";
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
      expect(result?.options.map((option) => option.label)).toEqual(["note", "info", "success", "warning", "danger", "data"]);
    } finally {
      Object.assign(globalThis, { document: previousDocument });
    }
  });
});
