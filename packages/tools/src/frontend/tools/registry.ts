import { i18n } from "@k2b/stdlib";

export type ToolCategory = "images" | "documents" | "text" | "security" | "network";

export type ToolId =
  | "mailto"
  | "qr"
  | "uuid"
  | "lorem"
  | "encoding"
  | "color"
  | "document-markdown"
  | "markdown-pdf"
  | "hash"
  | "password"
  | "encryption"
  | "image-converter"
  | "image"
  | "speedtest"
  | "webhooks";

export type ToolDef = {
  id: ToolId;
  icon: string;
  category: ToolCategory;
  /** Locale-independent search terms; English and German live in one array. */
  keywords?: string[];
  /** Show in the compact quick-tools group and rank first in search. */
  featured?: boolean;
};

export type LocalizedTool = ToolDef & { name: string; description: string };

export const categoryOrder: ToolCategory[] = ["images", "documents", "text", "security", "network"];

const categoryIcons: Record<ToolCategory, string> = {
  images: "ti ti-photo",
  documents: "ti ti-files",
  text: "ti ti-text-size",
  security: "ti ti-shield-lock",
  network: "ti ti-network",
};

/** Human-facing registry text: category labels and tool copy. */
export const registryMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      appName: "Tools",
      home: "Home",
      categoryImages: "Images",
      categoryDocuments: "Documents",
      categoryText: "Text and codes",
      categorySecurity: "Security",
      categoryNetwork: "Network",
      mailtoName: "Email link",
      mailtoDescription: "Build email links with recipients, subject, and body.",
      qrName: "QR Code",
      qrDescription: "Turn links, WiFi access, contacts, and text into QR codes.",
      uuidName: "UUID",
      uuidDescription: "Generate one or many random UUIDs.",
      loremName: "Placeholder text",
      loremDescription: "Generate placeholder words, sentences, and paragraphs.",
      encodingName: "Encode text",
      encodingDescription: "Encode and decode text as Base64, Hex, or Base32.",
      colorName: "Colors",
      colorDescription: "Convert colors between HEX, RGB, and HSL.",
      documentMarkdownName: "Document to Markdown",
      documentMarkdownDescription: "Extract readable text from documents as plain Markdown.",
      markdownPdfName: "Markdown to PDF",
      markdownPdfDescription: "Turn Markdown into a styled PDF with print-ready templates and custom CSS.",
      hashName: "Checksum",
      hashDescription: "Generate SHA-256 and FNV-1a hashes.",
      passwordName: "Password",
      passwordDescription: "Create a secure random, memorable, or PIN-style password.",
      encryptionName: "Encrypt text",
      encryptionDescription: "Encrypt data with AES-GCM or ECDH.",
      imageConverterName: "Convert images",
      imageConverterDescription: "Convert, resize, rotate, and export many images at once.",
      imageName: "Edit photo",
      imageDescription: "Crop, adjust, annotate, redact, and export images.",
      speedtestName: "Speed test",
      speedtestDescription: "Measure download, upload, ping, and jitter.",
      webhooksName: "Webhook Tester",
      webhooksDescription: "Receive, send, and inspect HTTP requests.",
    },
    de: {
      appName: "Werkzeuge",
      home: "Start",
      categoryImages: "Bilder",
      categoryDocuments: "Dokumente",
      categoryText: "Text und Codes",
      categorySecurity: "Sicherheit",
      categoryNetwork: "Netzwerk",
      mailtoName: "E-Mail-Link",
      mailtoDescription: "E-Mail-Links mit Empfängern, Betreff und Text erstellen.",
      qrName: "QR-Code",
      qrDescription: "Links, WLAN-Zugänge, Kontakte und Text als QR-Codes ausgeben.",
      uuidName: "UUID",
      uuidDescription: "Eine oder mehrere zufällige UUIDs erzeugen.",
      loremName: "Blindtext",
      loremDescription: "Blindtext als Wörter, Sätze oder Absätze erzeugen.",
      encodingName: "Text kodieren",
      encodingDescription: "Text als Base64, Hex oder Base32 kodieren und dekodieren.",
      colorName: "Farben",
      colorDescription: "Farben zwischen HEX, RGB und HSL umrechnen.",
      documentMarkdownName: "Dokument zu Markdown",
      documentMarkdownDescription: "Lesbaren Text aus Dokumenten als Markdown extrahieren.",
      markdownPdfName: "Markdown zu PDF",
      markdownPdfDescription: "Markdown mit druckfertigen Vorlagen und eigenem CSS als gestaltetes PDF ausgeben.",
      hashName: "Prüfsumme",
      hashDescription: "SHA-256- und FNV-1a-Hashes erzeugen.",
      passwordName: "Passwort",
      passwordDescription: "Ein zufälliges, merkbares oder PIN-basiertes Passwort erzeugen.",
      encryptionName: "Text verschlüsseln",
      encryptionDescription: "Daten mit AES-GCM oder ECDH verschlüsseln.",
      imageConverterName: "Bilder umwandeln",
      imageConverterDescription: "Mehrere Bilder gemeinsam konvertieren, skalieren, drehen und exportieren.",
      imageName: "Foto bearbeiten",
      imageDescription: "Bilder zuschneiden, anpassen, beschriften, schwärzen und exportieren.",
      speedtestName: "Speedtest",
      speedtestDescription: "Download, Upload, Ping und Jitter messen.",
      webhooksName: "Webhook-Tester",
      webhooksDescription: "HTTP-Anfragen empfangen, senden und untersuchen.",
    },
  },
});

type RegistryText = ReturnType<typeof registryMessages.resolve>["t"];

const toolText = (t: RegistryText): Record<ToolId, { name: string; description: string }> => ({
  mailto: { name: t.mailtoName, description: t.mailtoDescription },
  qr: { name: t.qrName, description: t.qrDescription },
  uuid: { name: t.uuidName, description: t.uuidDescription },
  lorem: { name: t.loremName, description: t.loremDescription },
  encoding: { name: t.encodingName, description: t.encodingDescription },
  color: { name: t.colorName, description: t.colorDescription },
  "document-markdown": { name: t.documentMarkdownName, description: t.documentMarkdownDescription },
  "markdown-pdf": { name: t.markdownPdfName, description: t.markdownPdfDescription },
  hash: { name: t.hashName, description: t.hashDescription },
  password: { name: t.passwordName, description: t.passwordDescription },
  encryption: { name: t.encryptionName, description: t.encryptionDescription },
  "image-converter": { name: t.imageConverterName, description: t.imageConverterDescription },
  image: { name: t.imageName, description: t.imageDescription },
  speedtest: { name: t.speedtestName, description: t.speedtestDescription },
  webhooks: { name: t.webhooksName, description: t.webhooksDescription },
});

export const tools: ToolDef[] = [
  {
    id: "image",
    featured: true,
    icon: "ti ti-photo-edit",
    category: "images",
    keywords: [
      "photo",
      "resize",
      "crop",
      "rotate",
      "filter",
      "convert",
      "markup",
      "annotate",
      "redact",
      "bild",
      "foto",
      "skalieren",
      "größe ändern",
      "zuschneiden",
      "schwärzen",
      "drehen",
    ],
  },
  {
    id: "image-converter",
    icon: "ti ti-arrows-exchange",
    category: "images",
    keywords: [
      "photo",
      "batch",
      "resize",
      "rotate",
      "jpg",
      "jpeg",
      "png",
      "webp",
      "base64",
      "html",
      "zip",
      "bild",
      "bilder",
      "foto",
      "skalieren",
      "größe ändern",
      "drehen",
    ],
  },
  {
    id: "document-markdown",
    icon: "ti ti-markdown",
    category: "documents",
    keywords: ["document", "pdf", "word", "powerpoint", "spreadsheet", "csv", "epub", "text", "extract", "dokument", "extrahieren"],
  },
  {
    id: "markdown-pdf",
    icon: "ti ti-file-type-pdf",
    category: "documents",
    keywords: ["markdown", "pdf", "document", "print", "css", "export", "dokument", "drucken", "exportieren"],
  },
  {
    id: "qr",
    featured: true,
    icon: "ti ti-qrcode",
    category: "text",
    keywords: ["url", "link", "wifi", "vcard", "contact", "scan", "wlan", "kontakt"],
  },
  {
    id: "mailto",
    icon: "ti ti-mail-forward",
    category: "text",
    keywords: ["email", "compose", "recipient", "subject", "e-mail", "empfänger", "betreff"],
  },
  {
    id: "encoding",
    icon: "ti ti-transform",
    category: "text",
    keywords: ["base64", "hex", "base32", "decode", "text", "data", "kodieren", "dekodieren", "daten"],
  },
  {
    id: "color",
    icon: "ti ti-palette",
    category: "text",
    keywords: ["hex", "rgb", "hsl", "palette", "farbe", "farben"],
  },
  {
    id: "lorem",
    icon: "ti ti-align-left",
    category: "text",
    keywords: ["placeholder", "words", "sentences", "paragraphs", "platzhalter", "blindtext", "wörter", "sätze", "absätze"],
  },
  {
    id: "uuid",
    icon: "ti ti-fingerprint",
    category: "text",
    keywords: ["random", "id", "identifier", "v4", "zufällig", "kennung"],
  },
  {
    id: "password",
    featured: true,
    icon: "ti ti-key",
    category: "security",
    keywords: [
      "random",
      "memorable",
      "pin",
      "secure",
      "credentials",
      "passwort",
      "kennwort",
      "passwortgenerator",
      "zufällig",
      "sicher",
      "merkbar",
    ],
  },
  {
    id: "encryption",
    icon: "ti ti-lock",
    category: "security",
    keywords: ["aes", "gcm", "ecdh", "symmetric", "asymmetric", "decrypt", "verschlüsseln", "entschlüsseln"],
  },
  {
    id: "hash",
    icon: "ti ti-hash",
    category: "security",
    keywords: ["sha", "sha256", "fnv", "checksum", "digest", "prüfsumme"],
  },
  {
    id: "speedtest",
    featured: true,
    icon: "ti ti-gauge",
    category: "network",
    keywords: ["internet", "connection", "download", "upload", "ping", "jitter", "geschwindigkeit", "verbindung"],
  },
  {
    id: "webhooks",
    icon: "ti ti-webhook",
    category: "network",
    keywords: ["http", "endpoint", "request", "response", "api", "network", "anfrage", "antwort", "endpunkt", "netzwerk"],
  },
];

export type LocalizedRegistry = {
  /** The catalog locale the requested tags resolved to. */
  locale: string;
  tools: LocalizedTool[];
  categories: Record<ToolCategory, { label: string; icon: string }>;
  /** Returns one localized tool by id for route resolution and detail pages. */
  toolById: (id: string) => LocalizedTool | undefined;
  /** Search text shared by the overview and spotlight search. */
  searchText: (tool: LocalizedTool) => string;
};

/**
 * Resolves the tool registry for one locale. Use `getLocale(c)` on the server
 * and the inherited `useLocale()` in Solid components and islands.
 */
export const resolveRegistry = (requestedLocale: string): LocalizedRegistry => {
  const { locale, t } = registryMessages.resolve([requestedLocale]);
  const text = toolText(t);
  const localizedTools = tools.map((tool) => ({ ...tool, ...text[tool.id] }));
  const categories: LocalizedRegistry["categories"] = {
    images: { label: t.categoryImages, icon: categoryIcons.images },
    documents: { label: t.categoryDocuments, icon: categoryIcons.documents },
    text: { label: t.categoryText, icon: categoryIcons.text },
    security: { label: t.categorySecurity, icon: categoryIcons.security },
    network: { label: t.categoryNetwork, icon: categoryIcons.network },
  };
  return {
    locale,
    tools: localizedTools,
    categories,
    toolById: (id) => localizedTools.find((tool) => tool.id === id),
    searchText: (tool) =>
      [tool.name, tool.description, tool.id, categories[tool.category].label, ...(tool.keywords ?? [])].join(" ").toLowerCase(),
  };
};
