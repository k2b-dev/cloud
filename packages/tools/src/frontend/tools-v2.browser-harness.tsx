import { LocaleProvider } from "@k2b/ui";
import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import ToolCatalog from "./ToolCatalog.island";
import ColorConverter from "./tools/ColorConverter.island";
import DocumentMarkdown, { DocumentMarkdownView } from "./tools/DocumentMarkdown.island";
import EncodingTool from "./tools/EncodingTool.island";
import EncryptionTool from "./tools/EncryptionTool.island";
import HashGenerator from "./tools/HashGenerator.island";
import LoremIpsumGenerator from "./tools/LoremIpsumGenerator.island";
import MailtoGenerator from "./tools/MailtoGenerator.island";
import MarkdownPdf from "./tools/MarkdownPdf.island";
import PasswordGenerator from "./tools/PasswordGenerator.island";
import QrCodeGenerator from "./tools/QrCodeGenerator.island";
import UuidGenerator from "./tools/UuidGenerator.island";

const documentFixture = [
  "# Angebot 2026-0418",
  "",
  "Sehr geehrte Damen und Herren, vielen Dank für Ihre Anfrage. Wir bieten Ihnen die folgenden Leistungen an:",
  "",
  "## Leistungen",
  "",
  "- Wartung der Heizungsanlage, **zweimal jährlich**",
  "- Austausch der Thermostatventile im Erdgeschoss",
  "- Prüfung der Abgaswerte nach 1. BImSchV",
  "",
  "Das Angebot gilt bis zum 31. Dezember 2026. Fragen beantworten wir gern unter https://example.org/kontakt.",
].join("\n");

// One Tools screen on v2 per address: `?screen=catalog` (with `q`), or a tool id.
export const v2Screens: Record<string, () => JSX.Element> = {
  catalog: () => <ToolCatalog search={new URL(location.href).searchParams.get("q") ?? ""} />,
  password: () => <PasswordGenerator />,
  uuid: () => <UuidGenerator />,
  lorem: () => <LoremIpsumGenerator />,
  hash: () => <HashGenerator />,
  encoding: () => <EncodingTool />,
  color: () => <ColorConverter />,
  mailto: () => <MailtoGenerator />,
  encryption: () => <EncryptionTool />,
  qr: () => <QrCodeGenerator />,
  "document-markdown": () => <DocumentMarkdown />,
  // a converted document: an invented quote with a heading, a list and a link.
  // k2b-ui gap: Prose draws a Markdown table with 700 heads, without cell gaps ("2" and "320,00 €" read as
  // "2320,00 €") and off the text edge; the table returns to this fixture once Prose sets tables.
  "document-result": () => (
    <DocumentMarkdownView
      initialResult={{
        filename: "Angebot-2026-0418-Musterbetrieb.docx",
        format: "docx",
        markdown: documentFixture,
        inputBytes: 48_213,
        outputBytes: documentFixture.length,
        truncated: false,
      }}
    />
  ),
  "markdown-pdf": () => <MarkdownPdf />,
};

const params = new URL(location.href).searchParams;
render(
  () => (
    <LocaleProvider locale={params.get("locale") ?? "de"}>
      {(v2Screens[params.get("screen") ?? "catalog"] ?? v2Screens.catalog!)()}
    </LocaleProvider>
  ),
  document.getElementById("app")!,
);
