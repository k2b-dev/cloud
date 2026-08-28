import { describe, expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { kitCompletionSource } from "./kit-autocomplete";
import { markdownExtension } from "./markdown";

const completionFor = (source: string, locale = "en") => {
  const previousDocument = globalThis.document;
  Object.assign(globalThis, { document: { documentElement: { lang: locale } } });
  const pos = source.indexOf("\n```");
  const state = EditorState.create({ doc: source, extensions: [markdownExtension()] });
  try {
    return kitCompletionSource(new CompletionContext(state, pos, true));
  } finally {
    Object.assign(globalThis, { document: previousDocument });
  }
};

const completionPaths = [
  "c",
  "n",
  "u",
  "s",
  "current.",
  "current.kv.",
  "nb.",
  "nb.attachments.",
  "nb.tags.",
  "nb.localKV.",
  "ui.",
  "ui.prompt.",
  "std.",
  "std.text.",
  "std.dates.",
  "std.fuzzy.",
  "std.crypto.",
  "std.encoding.",
  "std.charts.",
  "std.qr.",
  "std.password.",
  "std.timing.",
  "std.files.",
  "std.images.",
  "std.clipboard.",
] as const;

const isTechnicalDetail = (detail: unknown): detail is string =>
  typeof detail === "string" &&
  (detail.startsWith("(") || /^(?:string|number|boolean|Date\[\]|Uint8Array|Promise|ISO |ECDSA|AES-GCM|\{)/.test(detail));

describe("notebook script API autocomplete", () => {
  test("localizes visible help for de-CH while preserving API labels and signatures", () => {
    const result = completionFor("```script\ncurrent.\n```", "de-CH");
    const table = result?.options.find((option) => option.label === "table");

    expect(table?.detail).toBe("(name) → table view | undefined");
    expect(table?.info).toContain("benannte Markdown-Tabelle");
    expect(result?.options.map((option) => option.label)).toContain("setContent");
    expect(result?.options.some((option) => String(option.info).includes("Read a named"))).toBe(false);
  });

  test("provides complete German help without changing completion code", () => {
    for (const path of completionPaths) {
      const source = `\`\`\`script\n${path}\n\`\`\``;
      const english = completionFor(source, "en");
      const german = completionFor(source, "de-CH");

      expect(german?.options.length, path).toBe(english?.options.length);
      for (const [index, option] of german?.options.entries() ?? []) {
        const original = english?.options[index];
        expect(original, `${path}${option.label}`).toBeDefined();
        if (!original) throw new Error(`Missing English completion for ${path}${option.label}`);
        expect(option.label).toBe(original.label);
        expect(option.type).toBe(original.type);
        expect(option.apply).toBe(original.apply);
        expect(String(option.info).trim().length, `${path}${option.label}`).toBeGreaterThan(0);
        expect(option.info, `${path}${option.label}`).not.toBe(original.info);
        if (isTechnicalDetail(original.detail)) expect(option.detail).toBe(original.detail);
      }
    }
  });
});
