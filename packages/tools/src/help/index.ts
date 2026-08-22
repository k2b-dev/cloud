import { defineHelp } from "@valentinkolb/cloud/server";
import choose from "./documents/tools-choose.help.md" with { type: "text" };
import documentMarkdown from "./documents/tools-document-markdown.help.md" with { type: "text" };
import imageConverter from "./documents/tools-image-converter.help.md" with { type: "text" };
import markdownPdf from "./documents/tools-markdown-pdf.help.md" with { type: "text" };
import safety from "./documents/tools-safety.help.md" with { type: "text" };
import start from "./documents/tools-start.help.md" with { type: "text" };

export const toolsHelp = defineHelp({
  documents: [start, choose, documentMarkdown, markdownPdf, imageConverter, safety],
});
