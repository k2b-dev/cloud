export type ToolCategory = "generators" | "encoders" | "security" | "media" | "network";
export type ToolTaskGroup = "create" | "transform" | "test";

export type ToolDef = {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: ToolCategory;
  taskGroup: ToolTaskGroup;
  keywords?: string[];
  color: "blue" | "emerald" | "violet" | "orange" | "red" | "amber" | "zinc";
  /** Show in the compact quick-tools group and rank first in search. */
  featured?: boolean;
};

export const categoryOrder: ToolCategory[] = ["generators", "encoders", "security", "media", "network"];

export const categories: Record<ToolCategory, { label: string; icon: string }> = {
  generators: { label: "Generators", icon: "ti ti-sparkles" },
  encoders: { label: "Encoders", icon: "ti ti-arrows-exchange" },
  security: { label: "Security", icon: "ti ti-shield-lock" },
  media: { label: "Media", icon: "ti ti-photo" },
  network: { label: "Network", icon: "ti ti-network" },
};

export const taskGroupOrder: ToolTaskGroup[] = ["create", "transform", "test"];

export const taskGroups: Record<ToolTaskGroup, { label: string; description: string; icon: string }> = {
  create: {
    label: "Create",
    description: "Generate links, codes, identifiers, and text.",
    icon: "ti ti-sparkles",
  },
  transform: {
    label: "Convert and protect",
    description: "Change formats, process media, or secure data.",
    icon: "ti ti-transform",
  },
  test: {
    label: "Test and inspect",
    description: "Check connections and inspect HTTP traffic.",
    icon: "ti ti-test-pipe",
  },
};

export const tools: ToolDef[] = [
  // Generators
  {
    id: "mailto",
    name: "Mailto Link",
    icon: "ti ti-mail-forward",
    description: "Build email links with recipients, subject, and body.",
    category: "generators",
    taskGroup: "create",
    keywords: ["email", "compose", "recipient", "subject"],
    color: "blue",
  },
  {
    id: "qr",
    name: "QR Code",
    icon: "ti ti-qrcode",
    description: "Turn links, WiFi access, contacts, and text into QR codes.",
    category: "generators",
    taskGroup: "create",
    keywords: ["url", "link", "wifi", "vcard", "contact", "scan"],
    color: "emerald",
    featured: true,
  },
  {
    id: "uuid",
    name: "UUID",
    icon: "ti ti-fingerprint",
    description: "Generate one or many random UUIDs.",
    category: "generators",
    taskGroup: "create",
    keywords: ["random", "id", "identifier", "v4"],
    color: "blue",
  },
  {
    id: "lorem",
    name: "Lorem Ipsum",
    icon: "ti ti-align-left",
    description: "Generate placeholder words, sentences, and paragraphs.",
    category: "generators",
    taskGroup: "create",
    keywords: ["placeholder", "words", "sentences", "paragraphs"],
    color: "emerald",
  },
  // Encoders
  {
    id: "encoding",
    name: "Base64 / Hex / Base32",
    icon: "ti ti-transform",
    description: "Encode and decode text as Base64, Hex, or Base32.",
    category: "encoders",
    taskGroup: "transform",
    keywords: ["base64", "hex", "base32", "decode", "text", "data"],
    color: "violet",
  },
  {
    id: "color",
    name: "Color Converter",
    icon: "ti ti-palette",
    description: "Convert colors between HEX, RGB, and HSL.",
    category: "encoders",
    taskGroup: "transform",
    keywords: ["hex", "rgb", "hsl", "palette"],
    color: "orange",
  },
  {
    id: "document-markdown",
    name: "Document to Markdown",
    icon: "ti ti-markdown",
    description: "Extract readable text from documents as plain Markdown.",
    category: "encoders",
    taskGroup: "transform",
    keywords: ["document", "pdf", "word", "powerpoint", "spreadsheet", "csv", "epub", "text", "extract"],
    color: "violet",
    featured: true,
  },
  {
    id: "markdown-pdf",
    name: "Markdown to PDF",
    icon: "ti ti-file-type-pdf",
    description: "Turn Markdown into a styled PDF with print-ready templates and custom CSS.",
    category: "encoders",
    taskGroup: "create",
    keywords: ["markdown", "pdf", "document", "print", "css", "export"],
    color: "red",
    featured: true,
  },
  // Security
  {
    id: "hash",
    name: "Hash Generator",
    icon: "ti ti-hash",
    description: "Generate SHA-256 and FNV-1a hashes.",
    category: "security",
    taskGroup: "transform",
    keywords: ["sha", "sha256", "fnv", "checksum", "digest"],
    color: "red",
  },
  {
    id: "password",
    name: "Password Generator",
    icon: "ti ti-key",
    description: "Create a secure random, memorable, or PIN-style password.",
    category: "security",
    taskGroup: "create",
    keywords: ["random", "memorable", "pin", "secure", "credentials"],
    color: "blue",
    featured: true,
  },
  {
    id: "encryption",
    name: "Encryption",
    icon: "ti ti-lock",
    description: "Encrypt data with AES-GCM or ECDH.",
    category: "security",
    taskGroup: "transform",
    keywords: ["aes", "gcm", "ecdh", "symmetric", "asymmetric", "decrypt"],
    color: "amber",
  },
  // Media
  {
    id: "image-converter",
    name: "Image Converter",
    icon: "ti ti-arrows-exchange",
    description: "Convert, resize, rotate, and export many images at once.",
    category: "media",
    taskGroup: "transform",
    keywords: ["photo", "batch", "resize", "rotate", "jpg", "jpeg", "png", "webp", "base64", "html", "zip"],
    color: "violet",
    featured: true,
  },
  {
    id: "image",
    name: "Image Processor",
    icon: "ti ti-photo-edit",
    description: "Crop, adjust, annotate, redact, and export images.",
    category: "media",
    taskGroup: "transform",
    keywords: ["photo", "resize", "crop", "rotate", "filter", "convert", "markup", "annotate", "redact"],
    color: "violet",
    featured: true,
  },
  // Network
  {
    id: "speedtest",
    name: "Internet Speed Test",
    icon: "ti ti-gauge",
    description: "Measure download, upload, ping, and jitter.",
    category: "network",
    taskGroup: "test",
    keywords: ["internet", "connection", "download", "upload", "ping", "jitter"],
    color: "emerald",
  },
  {
    id: "webhooks",
    name: "Webhook Tester",
    icon: "ti ti-webhook",
    description: "Receive, send, and inspect HTTP requests.",
    category: "network",
    taskGroup: "test",
    keywords: ["http", "endpoint", "request", "response", "api", "network"],
    color: "blue",
    featured: true,
  },
];

/**
 * Returns one tool definition by id for route resolution and detail pages.
 */
export const toolById = (id: string): ToolDef | undefined => tools.find((t) => t.id === id);

/**
 * Returns all tool definitions that belong to the requested category.
 */
export const toolsByCategory = (category: ToolCategory): ToolDef[] => tools.filter((t) => t.category === category);

/** Search text shared by the overview and spotlight search. */
export const toolSearchText = (tool: ToolDef): string =>
  [tool.name, tool.description, tool.id, categories[tool.category].label, taskGroups[tool.taskGroup].label, ...(tool.keywords ?? [])]
    .join(" ")
    .toLowerCase();
