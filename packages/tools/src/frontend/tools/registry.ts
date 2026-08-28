import { i18n } from "@k2b/stdlib";

export type ToolCategory = "generators" | "encoders" | "security" | "media" | "network";
export type ToolTaskGroup = "create" | "transform" | "test";

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
  taskGroup: ToolTaskGroup;
  /** Locale-independent search terms; English and German live in one array. */
  keywords?: string[];
  color: "blue" | "emerald" | "violet" | "orange" | "red" | "amber" | "zinc";
  /** Show in the compact quick-tools group and rank first in search. */
  featured?: boolean;
};

export type LocalizedTool = ToolDef & { name: string; description: string };

export const categoryOrder: ToolCategory[] = ["generators", "encoders", "security", "media", "network"];

export const taskGroupOrder: ToolTaskGroup[] = ["create", "transform", "test"];

const categoryIcons: Record<ToolCategory, string> = {
  generators: "ti ti-sparkles",
  encoders: "ti ti-arrows-exchange",
  security: "ti ti-shield-lock",
  media: "ti ti-photo",
  network: "ti ti-network",
};

const taskGroupIcons: Record<ToolTaskGroup, string> = {
  create: "ti ti-sparkles",
  transform: "ti ti-transform",
  test: "ti ti-test-pipe",
};

/** Human-facing registry text: category labels, task groups, and tool copy. */
export const registryMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      categoryGenerators: "Generators",
      categoryEncoders: "Encoders",
      categorySecurity: "Security",
      categoryMedia: "Media",
      categoryNetwork: "Network",
      groupCreateLabel: "Create",
      groupCreateDescription: "Generate links, codes, identifiers, and text.",
      groupTransformLabel: "Convert and protect",
      groupTransformDescription: "Change formats, process media, or secure data.",
      groupTestLabel: "Test and inspect",
      groupTestDescription: "Check connections and inspect HTTP traffic.",
      mailtoName: "Mailto Link",
      mailtoDescription: "Build email links with recipients, subject, and body.",
      qrName: "QR Code",
      qrDescription: "Turn links, WiFi access, contacts, and text into QR codes.",
      uuidName: "UUID",
      uuidDescription: "Generate one or many random UUIDs.",
      loremName: "Lorem Ipsum",
      loremDescription: "Generate placeholder words, sentences, and paragraphs.",
      encodingName: "Base64 / Hex / Base32",
      encodingDescription: "Encode and decode text as Base64, Hex, or Base32.",
      colorName: "Color Converter",
      colorDescription: "Convert colors between HEX, RGB, and HSL.",
      documentMarkdownName: "Document to Markdown",
      documentMarkdownDescription: "Extract readable text from documents as plain Markdown.",
      markdownPdfName: "Markdown to PDF",
      markdownPdfDescription: "Turn Markdown into a styled PDF with print-ready templates and custom CSS.",
      hashName: "Hash Generator",
      hashDescription: "Generate SHA-256 and FNV-1a hashes.",
      passwordName: "Password Generator",
      passwordDescription: "Create a secure random, memorable, or PIN-style password.",
      encryptionName: "Encryption",
      encryptionDescription: "Encrypt data with AES-GCM or ECDH.",
      imageConverterName: "Image Converter",
      imageConverterDescription: "Convert, resize, rotate, and export many images at once.",
      imageName: "Image Processor",
      imageDescription: "Crop, adjust, annotate, redact, and export images.",
      speedtestName: "Internet Speed Test",
      speedtestDescription: "Measure download, upload, ping, and jitter.",
      webhooksName: "Webhook Tester",
      webhooksDescription: "Receive, send, and inspect HTTP requests.",
    },
    de: {
      categoryGenerators: "Generatoren",
      categoryEncoders: "Konverter",
      categorySecurity: "Sicherheit",
      categoryMedia: "Medien",
      categoryNetwork: "Netzwerk",
      groupCreateLabel: "Erstellen",
      groupCreateDescription: "Links, Codes, IDs und Text erzeugen.",
      groupTransformLabel: "Umwandeln und schützen",
      groupTransformDescription: "Formate umwandeln, Medien bearbeiten und Daten schützen.",
      groupTestLabel: "Testen und prüfen",
      groupTestDescription: "Verbindungen testen und HTTP-Verkehr untersuchen.",
      mailtoName: "Mailto-Link",
      mailtoDescription: "E-Mail-Links mit Empfängern, Betreff und Text erstellen.",
      qrName: "QR-Code",
      qrDescription: "Links, WLAN-Zugänge, Kontakte und Text als QR-Codes ausgeben.",
      uuidName: "UUID",
      uuidDescription: "Eine oder mehrere zufällige UUIDs erzeugen.",
      loremName: "Lorem Ipsum",
      loremDescription: "Blindtext als Wörter, Sätze oder Absätze erzeugen.",
      encodingName: "Base64 / Hex / Base32",
      encodingDescription: "Text als Base64, Hex oder Base32 kodieren und dekodieren.",
      colorName: "Farbkonverter",
      colorDescription: "Farben zwischen HEX, RGB und HSL umrechnen.",
      documentMarkdownName: "Dokument zu Markdown",
      documentMarkdownDescription: "Lesbaren Text aus Dokumenten als Markdown extrahieren.",
      markdownPdfName: "Markdown zu PDF",
      markdownPdfDescription: "Markdown mit druckfertigen Vorlagen und eigenem CSS als gestaltetes PDF ausgeben.",
      hashName: "Hash-Generator",
      hashDescription: "SHA-256- und FNV-1a-Hashes erzeugen.",
      passwordName: "Passwortgenerator",
      passwordDescription: "Ein zufälliges, merkbares oder PIN-basiertes Passwort erzeugen.",
      encryptionName: "Verschlüsselung",
      encryptionDescription: "Daten mit AES-GCM oder ECDH verschlüsseln.",
      imageConverterName: "Bildkonverter",
      imageConverterDescription: "Mehrere Bilder gemeinsam konvertieren, skalieren, drehen und exportieren.",
      imageName: "Bildbearbeitung",
      imageDescription: "Bilder zuschneiden, anpassen, beschriften, schwärzen und exportieren.",
      speedtestName: "Internet-Speedtest",
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
  // Generators
  {
    id: "mailto",
    icon: "ti ti-mail-forward",
    category: "generators",
    taskGroup: "create",
    keywords: ["email", "compose", "recipient", "subject", "e-mail", "empfänger", "betreff"],
    color: "blue",
  },
  {
    id: "qr",
    icon: "ti ti-qrcode",
    category: "generators",
    taskGroup: "create",
    keywords: ["url", "link", "wifi", "vcard", "contact", "scan", "wlan", "kontakt"],
    color: "emerald",
    featured: true,
  },
  {
    id: "uuid",
    icon: "ti ti-fingerprint",
    category: "generators",
    taskGroup: "create",
    keywords: ["random", "id", "identifier", "v4", "zufällig", "kennung"],
    color: "blue",
  },
  {
    id: "lorem",
    icon: "ti ti-align-left",
    category: "generators",
    taskGroup: "create",
    keywords: ["placeholder", "words", "sentences", "paragraphs", "platzhalter", "blindtext", "wörter", "sätze", "absätze"],
    color: "emerald",
  },
  // Encoders
  {
    id: "encoding",
    icon: "ti ti-transform",
    category: "encoders",
    taskGroup: "transform",
    keywords: ["base64", "hex", "base32", "decode", "text", "data", "kodieren", "dekodieren", "daten"],
    color: "violet",
  },
  {
    id: "color",
    icon: "ti ti-palette",
    category: "encoders",
    taskGroup: "transform",
    keywords: ["hex", "rgb", "hsl", "palette", "farbe", "farben"],
    color: "orange",
  },
  {
    id: "document-markdown",
    icon: "ti ti-markdown",
    category: "encoders",
    taskGroup: "transform",
    keywords: ["document", "pdf", "word", "powerpoint", "spreadsheet", "csv", "epub", "text", "extract", "dokument", "extrahieren"],
    color: "violet",
    featured: true,
  },
  {
    id: "markdown-pdf",
    icon: "ti ti-file-type-pdf",
    category: "encoders",
    taskGroup: "create",
    keywords: ["markdown", "pdf", "document", "print", "css", "export", "dokument", "drucken", "exportieren"],
    color: "red",
    featured: true,
  },
  // Security
  {
    id: "hash",
    icon: "ti ti-hash",
    category: "security",
    taskGroup: "transform",
    keywords: ["sha", "sha256", "fnv", "checksum", "digest", "prüfsumme"],
    color: "red",
  },
  {
    id: "password",
    icon: "ti ti-key",
    category: "security",
    taskGroup: "create",
    keywords: ["random", "memorable", "pin", "secure", "credentials", "passwort", "kennwort", "zufällig", "sicher", "merkbar"],
    color: "blue",
    featured: true,
  },
  {
    id: "encryption",
    icon: "ti ti-lock",
    category: "security",
    taskGroup: "transform",
    keywords: ["aes", "gcm", "ecdh", "symmetric", "asymmetric", "decrypt", "verschlüsseln", "entschlüsseln"],
    color: "amber",
  },
  // Media
  {
    id: "image-converter",
    icon: "ti ti-arrows-exchange",
    category: "media",
    taskGroup: "transform",
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
    color: "violet",
    featured: true,
  },
  {
    id: "image",
    icon: "ti ti-photo-edit",
    category: "media",
    taskGroup: "transform",
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
    color: "violet",
    featured: true,
  },
  // Network
  {
    id: "speedtest",
    icon: "ti ti-gauge",
    category: "network",
    taskGroup: "test",
    keywords: ["internet", "connection", "download", "upload", "ping", "jitter", "geschwindigkeit", "verbindung"],
    color: "emerald",
  },
  {
    id: "webhooks",
    icon: "ti ti-webhook",
    category: "network",
    taskGroup: "test",
    keywords: ["http", "endpoint", "request", "response", "api", "network", "anfrage", "antwort", "endpunkt", "netzwerk"],
    color: "blue",
    featured: true,
  },
];

export type LocalizedRegistry = {
  /** The catalog locale the requested tags resolved to. */
  locale: string;
  tools: LocalizedTool[];
  categories: Record<ToolCategory, { label: string; icon: string }>;
  taskGroups: Record<ToolTaskGroup, { label: string; description: string; icon: string }>;
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
    generators: { label: t.categoryGenerators, icon: categoryIcons.generators },
    encoders: { label: t.categoryEncoders, icon: categoryIcons.encoders },
    security: { label: t.categorySecurity, icon: categoryIcons.security },
    media: { label: t.categoryMedia, icon: categoryIcons.media },
    network: { label: t.categoryNetwork, icon: categoryIcons.network },
  };
  const taskGroups: LocalizedRegistry["taskGroups"] = {
    create: { label: t.groupCreateLabel, description: t.groupCreateDescription, icon: taskGroupIcons.create },
    transform: { label: t.groupTransformLabel, description: t.groupTransformDescription, icon: taskGroupIcons.transform },
    test: { label: t.groupTestLabel, description: t.groupTestDescription, icon: taskGroupIcons.test },
  };
  return {
    locale,
    tools: localizedTools,
    categories,
    taskGroups,
    toolById: (id) => localizedTools.find((tool) => tool.id === id),
    searchText: (tool) =>
      [tool.name, tool.description, tool.id, categories[tool.category].label, taskGroups[tool.taskGroup].label, ...(tool.keywords ?? [])]
        .join(" ")
        .toLowerCase(),
  };
};
