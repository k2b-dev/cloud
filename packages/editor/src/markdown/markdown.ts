// Code languages load on first use, so hosts that never show a fenced block of a language never download its parser.
import { markdown as markdownExt, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { sizedImageSyntax } from "./image-syntax";

const codeLanguages = [
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js", "jsx", "ts", "tsx", "typescript"],
    load: async () => (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true }),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py"],
    load: async () => (await import("@codemirror/lang-python")).python(),
  }),
  LanguageDescription.of({
    name: "SQL",
    load: async () => (await import("@codemirror/lang-sql")).sql(),
  }),
  LanguageDescription.of({
    name: "HTML",
    alias: ["htm"],
    load: async () => {
      const { html } = await import("@codemirror/lang-html");
      return html();
    },
  }),
  LanguageDescription.of({
    name: "CSS",
    load: async () => (await import("@codemirror/lang-css")).css(),
  }),
  LanguageDescription.of({
    name: "JSON",
    load: async () => (await import("@codemirror/lang-json")).json(),
  }),
  LanguageDescription.of({
    name: "Go",
    alias: ["golang"],
    load: async () => (await import("@codemirror/lang-go")).go(),
  }),
  LanguageDescription.of({
    name: "Java",
    load: async () => (await import("@codemirror/lang-java")).java(),
  }),
  LanguageDescription.of({
    name: "XML",
    alias: ["svg"],
    load: async () => (await import("@codemirror/lang-xml")).xml(),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yml"],
    load: async () => (await import("@codemirror/lang-yaml")).yaml(),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs"],
    load: async () => (await import("@codemirror/lang-rust")).rust(),
  }),
  LanguageDescription.of({
    name: "C++",
    alias: ["cpp", "c", "h", "hpp"],
    load: async () => (await import("@codemirror/lang-cpp")).cpp(),
  }),
  LanguageDescription.of({
    name: "PHP",
    load: async () => (await import("@codemirror/lang-php")).php(),
  }),
];

export const markdownExtension: () => Extension = () =>
  markdownExt({
    base: markdownLanguage,
    codeLanguages,
    extensions: [sizedImageSyntax],
  });
