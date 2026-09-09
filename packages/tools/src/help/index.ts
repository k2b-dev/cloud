import { defineHelp } from "@k2b/cloud/server";
import chooseDe from "./documents/de/tools-choose.help.md" with { type: "text" };
import documentMarkdownDe from "./documents/de/tools-document-markdown.help.md" with { type: "text" };
import imageConverterDe from "./documents/de/tools-image-converter.help.md" with { type: "text" };
import markdownPdfDe from "./documents/de/tools-markdown-pdf.help.md" with { type: "text" };
import safetyDe from "./documents/de/tools-safety.help.md" with { type: "text" };
import startDe from "./documents/de/tools-start.help.md" with { type: "text" };
import choose from "./documents/en/tools-choose.help.md" with { type: "text" };
import documentMarkdown from "./documents/en/tools-document-markdown.help.md" with { type: "text" };
import imageConverter from "./documents/en/tools-image-converter.help.md" with { type: "text" };
import markdownPdf from "./documents/en/tools-markdown-pdf.help.md" with { type: "text" };
import safety from "./documents/en/tools-safety.help.md" with { type: "text" };
import start from "./documents/en/tools-start.help.md" with { type: "text" };

export const toolsHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [start, choose, documentMarkdown, markdownPdf, imageConverter, safety],
    de: [startDe, chooseDe, documentMarkdownDe, markdownPdfDe, imageConverterDe, safetyDe],
  },
});
