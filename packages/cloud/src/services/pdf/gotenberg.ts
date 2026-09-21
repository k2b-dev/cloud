import * as settings from "../settings";

export type GotenbergRenderErrorCode =
  | "bad_input"
  | "not_configured"
  | "html_too_large"
  | "pdf_too_large"
  | "request_failed"
  | "bad_response"
  | "timeout";

export class GotenbergRenderError extends Error {
  constructor(
    readonly code: GotenbergRenderErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GotenbergRenderError";
  }
}

export type GotenbergConfig = {
  url: string;
  username?: string;
  password?: string;
  timeoutMs: number;
  maxHtmlBytes: number;
  maxPdfBytes: number;
};

export type RenderHtmlToPdfInput = {
  html: string;
  headerHtml?: string | null;
  footerHtml?: string | null;
  filename?: string;
  assets?: Array<{ name: string; data: Blob }>;
  page?: {
    format?: "A4" | "A3" | "A5" | "Letter" | "Legal";
    landscape?: boolean;
    margin?: { top?: number; right?: number; bottom?: number; left?: number };
  };
  tagged?: boolean;
};

export type AttachPdfFilesInput = {
  document: Blob;
  attachments: Array<{ name: string; data: Blob; relationship?: "Source" | "Data" | "Alternative" | "Supplement" | "Unspecified" }>;
};

export type RenderFacturXHtmlToPdfInput = RenderHtmlToPdfInput & {
  xml: string;
  conformanceLevel?: "MINIMUM" | "BASIC WL" | "BASIC" | "EN 16931" | "EXTENDED";
  documentType?: "INVOICE" | "ORDER" | "ORDER RESPONSE";
  facturXVersion?: "1.0";
};

export type RenderHtmlToPdfResult = {
  pdf: Uint8Array;
  contentType: string;
};

export type MergePdfsInput = {
  files: Array<{
    pdf: Uint8Array;
    filename?: string;
  }>;
};

export type GotenbergFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RenderHtmlToPdfOptions = {
  fetch?: GotenbergFetch;
  signal?: AbortSignal;
};

const DEFAULT_PDF_CONTENT_TYPE = "application/pdf";
const TEST_HTML = "<!doctype html><html><body><h1>Cloud PDF renderer test</h1></body></html>";

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

const normalizeBaseUrl = (url: string): string => {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new GotenbergRenderError("not_configured", "Gotenberg URL is not configured.");
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    throw new GotenbergRenderError("not_configured", "Gotenberg URL is invalid.");
  }
};

const basicAuthHeader = (config: GotenbergConfig): string | null => {
  const username = config.username?.trim() ?? "";
  const password = config.password ?? "";
  if (!username && !password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
};

const abortSignal = (timeoutMs: number): AbortSignal => {
  if (timeoutMs <= 0) {
    throw new GotenbergRenderError("not_configured", "Gotenberg timeout must be greater than 0 ms.");
  }
  return AbortSignal.timeout(timeoutMs);
};

const sanitizeFetchError = (error: unknown): GotenbergRenderError => {
  if (error instanceof GotenbergRenderError) return error;
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new GotenbergRenderError("timeout", "Gotenberg request timed out.");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new GotenbergRenderError("timeout", "Gotenberg request timed out.");
  }
  return new GotenbergRenderError("request_failed", "Gotenberg request failed.");
};

const dimensions = { A4: [210, 297], A3: [297, 420], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] } as const;
const fileName = (name: string) => {
  if (!name || name.length > 180 || /[\\/\x00-\x1f]/.test(name) || name === "." || name === "..")
    throw new GotenbergRenderError("bad_input", "Use a plain filename without directories.");
  return name;
};

function htmlForm(input: RenderHtmlToPdfInput, config: GotenbergConfig): FormData {
  const total =
    [input.html, input.headerHtml ?? "", input.footerHtml ?? ""].reduce((sum, value) => sum + byteLength(value), 0) +
    (input.assets ?? []).reduce((sum, asset) => sum + asset.data.size, 0);
  if (total > config.maxHtmlBytes) throw new GotenbergRenderError("html_too_large", "HTML and assets exceed the configured input budget.");
  const form = new FormData();
  form.append("files", new Blob([input.html], { type: "text/html" }), "index.html");
  if (input.headerHtml?.trim()) form.append("files", new Blob([input.headerHtml], { type: "text/html" }), "header.html");
  if (input.footerHtml?.trim()) form.append("files", new Blob([input.footerHtml], { type: "text/html" }), "footer.html");
  const names = new Set(["index.html", "header.html", "footer.html", "factur-x.xml"]);
  for (const asset of input.assets ?? []) {
    const name = fileName(asset.name);
    if (names.has(name.toLowerCase()))
      throw new GotenbergRenderError("bad_input", "Asset filenames must be unique and cannot replace HTML documents.");
    names.add(name.toLowerCase());
    form.append("files", asset.data, name);
  }
  // Preserve the existing CSS page-size contract unless a caller supplies page options.
  form.append("preferCssPageSize", String(!input.page));
  form.append("printBackground", "true");
  if (input.tagged !== undefined) form.append("generateTaggedPdf", String(input.tagged));
  if (input.page) {
    const [width, height] = dimensions[input.page.format ?? "A4"];
    form.append("paperWidth", String(width / 25.4));
    form.append("paperHeight", String(height / 25.4));
    form.append("landscape", String(input.page.landscape ?? false));
    for (const side of ["top", "right", "bottom", "left"] as const) {
      const value = input.page.margin?.[side] ?? 15;
      if (!Number.isFinite(value) || value < 0)
        throw new GotenbergRenderError("bad_input", "Page margins must be nonnegative millimeters.");
      form.append(`margin${side[0]!.toUpperCase()}${side.slice(1)}`, String(value / 25.4));
    }
  }
  return form;
}

/** Bounded transport shared by HTML conversion and attachment embedding. */
async function requestPdf(
  route: string,
  form: FormData,
  config: GotenbergConfig,
  options: RenderHtmlToPdfOptions,
): Promise<RenderHtmlToPdfResult> {
  const headers = new Headers();
  const auth = basicAuthHeader(config);
  if (auth) headers.set("Authorization", auth);
  const signal = options.signal ? AbortSignal.any([options.signal, abortSignal(config.timeoutMs)]) : abortSignal(config.timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await (options.fetch ?? fetch)(`${normalizeBaseUrl(config.url)}${route}`, {
      method: "POST",
      headers,
      body: form,
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new GotenbergRenderError("bad_response", `Gotenberg returned HTTP ${response.status}.`, response.status);
    }
    const contentType = response.headers.get("content-type") || DEFAULT_PDF_CONTENT_TYPE;
    if (contentType.split(";")[0] !== DEFAULT_PDF_CONTENT_TYPE) {
      await response.body?.cancel();
      throw new GotenbergRenderError("bad_response", "Gotenberg did not return a PDF.");
    }
    if (!response.body) throw new GotenbergRenderError("bad_response", "Gotenberg returned an empty response.");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > config.maxPdfBytes) throw new GotenbergRenderError("pdf_too_large", "PDF output exceeds the configured budget.");
      chunks.push(item.value);
    }
    const pdf = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      pdf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { pdf, contentType };
  } catch (error) {
    await reader?.cancel().catch(() => {});
    throw sanitizeFetchError(error);
  } finally {
    reader?.releaseLock();
  }
}

export const renderHtmlToPdfWithConfig = async (
  input: RenderHtmlToPdfInput,
  config: GotenbergConfig,
  options: RenderHtmlToPdfOptions = {},
): Promise<RenderHtmlToPdfResult> => requestPdf("/forms/chromium/convert/html", htmlForm(input, config), config, options);

export const renderFacturXHtmlToPdfWithConfig = async (
  input: RenderFacturXHtmlToPdfInput,
  config: GotenbergConfig,
  options: RenderHtmlToPdfOptions = {},
): Promise<RenderHtmlToPdfResult> => {
  const xmlBytes = byteLength(input.xml);
  if (!xmlBytes || xmlBytes > config.maxHtmlBytes)
    throw new GotenbergRenderError(
      xmlBytes ? "html_too_large" : "bad_input",
      "Invoice XML is empty or exceeds the configured input budget.",
    );
  const form = htmlForm(input, { ...config, maxHtmlBytes: config.maxHtmlBytes - xmlBytes });
  form.append("facturxXml", new Blob([input.xml], { type: "application/xml" }), "factur-x.xml");
  form.append("facturxConformanceLevel", input.conformanceLevel ?? "EN 16931");
  form.append("facturxDocumentType", input.documentType ?? "INVOICE");
  form.append("facturxVersion", input.facturXVersion ?? "1.0");
  form.append("pdfa", "PDF/A-3b");
  return requestPdf("/forms/chromium/convert/html", form, config, options);
};

export const attachPdfFilesWithConfig = async (
  input: AttachPdfFilesInput,
  config: GotenbergConfig,
  options: RenderHtmlToPdfOptions = {},
): Promise<RenderHtmlToPdfResult> => {
  if (!input.attachments.length) throw new GotenbergRenderError("bad_input", "At least one attachment is required.");
  if (input.document.size + input.attachments.reduce((sum, file) => sum + file.data.size, 0) > config.maxPdfBytes)
    throw new GotenbergRenderError("pdf_too_large", "PDF and attachments exceed the configured input budget.");
  const form = new FormData();
  form.append("files", input.document, "document.pdf");
  const metadata: Record<string, { mimeType: string; relationship: string }> = Object.create(null);
  const names = new Set<string>();
  for (const attachment of input.attachments) {
    const name = fileName(attachment.name);
    if (names.has(name.toLowerCase())) throw new GotenbergRenderError("bad_input", "Attachment filenames must be unique.");
    names.add(name.toLowerCase());
    form.append("embeds", attachment.data, name);
    metadata[name] = {
      mimeType: attachment.data.type || "application/octet-stream",
      relationship: attachment.relationship ?? "Unspecified",
    };
  }
  form.append("embedsMetadata", JSON.stringify(metadata));
  return requestPdf("/forms/pdfengines/embed", form, config, options);
};

export const mergePdfsWithConfig = async (
  input: MergePdfsInput,
  config: GotenbergConfig,
  options: RenderHtmlToPdfOptions = {},
): Promise<RenderHtmlToPdfResult> => {
  if (input.files.length === 0) {
    throw new GotenbergRenderError("bad_input", "At least one PDF file is required.");
  }

  const baseUrl = normalizeBaseUrl(config.url);
  const form = new FormData();
  input.files.forEach((file, index) => {
    const filename = `${String(index + 1).padStart(6, "0")}.pdf`;
    const bytes = file.pdf.buffer.slice(file.pdf.byteOffset, file.pdf.byteOffset + file.pdf.byteLength) as ArrayBuffer;
    form.append("files", new Blob([bytes], { type: DEFAULT_PDF_CONTENT_TYPE }), filename);
  });

  const headers = new Headers();
  const authHeader = basicAuthHeader(config);
  if (authHeader) headers.set("Authorization", authHeader);

  const transport = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await transport(`${baseUrl}/forms/pdfengines/merge`, {
      method: "POST",
      headers,
      body: form,
      signal: abortSignal(config.timeoutMs),
    });
  } catch (error) {
    throw sanitizeFetchError(error);
  }

  if (!response.ok) {
    throw new GotenbergRenderError("bad_response", `Gotenberg returned HTTP ${response.status}.`, response.status);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > config.maxPdfBytes) {
    throw new GotenbergRenderError(
      "pdf_too_large",
      `PDF output is too large (${buffer.byteLength} bytes, limit ${config.maxPdfBytes} bytes).`,
    );
  }

  return {
    pdf: new Uint8Array(buffer),
    contentType: response.headers.get("content-type") || DEFAULT_PDF_CONTENT_TYPE,
  };
};

export const getGotenbergConfig = async (): Promise<GotenbergConfig> => ({
  url: await settings.get<string>("gotenberg.url"),
  username: await settings.get<string>("gotenberg.username"),
  password: await settings.get<string>("gotenberg.password"),
  timeoutMs: await settings.get<number>("gotenberg.timeout_ms"),
  maxHtmlBytes: await settings.get<number>("gotenberg.max_html_bytes"),
  maxPdfBytes: await settings.get<number>("gotenberg.max_pdf_bytes"),
});

export const renderHtmlToPdf = async (input: RenderHtmlToPdfInput, options: RenderHtmlToPdfOptions = {}): Promise<RenderHtmlToPdfResult> =>
  renderHtmlToPdfWithConfig(input, await getGotenbergConfig(), options);

export const renderFacturXHtmlToPdf = async (
  input: RenderFacturXHtmlToPdfInput,
  options: RenderHtmlToPdfOptions = {},
): Promise<RenderHtmlToPdfResult> => renderFacturXHtmlToPdfWithConfig(input, await getGotenbergConfig(), options);

export const mergePdfs = async (input: MergePdfsInput, options: RenderHtmlToPdfOptions = {}): Promise<RenderHtmlToPdfResult> =>
  mergePdfsWithConfig(input, await getGotenbergConfig(), options);

export const testGotenberg = async (options: RenderHtmlToPdfOptions = {}): Promise<{ bytes: number; contentType: string }> => {
  const result = await renderHtmlToPdf({ html: TEST_HTML, filename: "index.html" }, options);
  return { bytes: result.pdf.byteLength, contentType: result.contentType };
};

export const attachPdfFiles = async (input: AttachPdfFilesInput, options: RenderHtmlToPdfOptions = {}): Promise<RenderHtmlToPdfResult> =>
  attachPdfFilesWithConfig(input, await getGotenbergConfig(), options);
