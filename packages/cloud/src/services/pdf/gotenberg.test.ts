import { describe, expect, test } from "bun:test";
import {
  type GotenbergConfig,
  GotenbergRenderError,
  mergePdfsWithConfig,
  renderFacturXHtmlToPdfWithConfig,
  renderHtmlToPdfWithConfig,
} from "./gotenberg";

const baseConfig = {
  url: "http://gotenberg:3000",
  timeoutMs: 5000,
  maxHtmlBytes: 1024,
  maxPdfBytes: 1024,
} satisfies GotenbergConfig;

const pdfResponse = (body = "%PDF-test", init?: ResponseInit) =>
  new Response(new TextEncoder().encode(body), {
    headers: { "content-type": "application/pdf" },
    ...init,
  });

describe("Gotenberg PDF renderer", () => {
  test("posts HTML to the chromium HTML endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const files: string[] = [];
    const result = await renderHtmlToPdfWithConfig(
      { html: "<h1>Hello</h1>", headerHtml: "<p>Head</p>", footerHtml: "<p>Foot</p>", filename: "ignored.html" },
      baseConfig,
      {
        fetch: async (url, init) => {
          calls.push({ url: String(url), init: init ?? {} });
          for (const file of (init?.body as FormData).getAll("files")) {
            if (file instanceof File) files.push(file.name);
          }
          return pdfResponse();
        },
      },
    );

    expect(result.contentType).toBe("application/pdf");
    expect(result.pdf.byteLength).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://gotenberg:3000/forms/chromium/convert/html");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBeInstanceOf(FormData);
    expect(files).toEqual(["index.html", "header.html", "footer.html"]);
    expect((calls[0]?.init.body as FormData).get("preferCssPageSize")).toBe("true");
    expect((calls[0]?.init.body as FormData).get("printBackground")).toBe("true");
  });

  test("adds basic auth only when credentials are configured", async () => {
    let authHeader = "";
    await renderHtmlToPdfWithConfig(
      { html: "<h1>Hello</h1>" },
      { ...baseConfig, username: "user", password: "secret" },
      {
        fetch: async (_url, init) => {
          authHeader = new Headers(init?.headers).get("authorization") ?? "";
          return pdfResponse();
        },
      },
    );

    expect(authHeader).toBe(`Basic ${Buffer.from("user:secret").toString("base64")}`);

    await renderHtmlToPdfWithConfig({ html: "<h1>Hello</h1>" }, baseConfig, {
      fetch: async (_url, init) => {
        authHeader = new Headers(init?.headers).get("authorization") ?? "";
        return pdfResponse();
      },
    });

    expect(authHeader).toBe("");
  });

  test("posts bounded Factur-X XML with the explicit EN 16931 PDF/A-3 contract", async () => {
    let form: FormData | null = null;
    await renderFacturXHtmlToPdfWithConfig({ html: "<h1>Invoice</h1>", xml: "<invoice/>" }, baseConfig, {
      fetch: async (_url, init) => {
        form = init?.body as FormData;
        return pdfResponse();
      },
    });
    expect((form as FormData | null)?.get("facturxConformanceLevel")).toBe("EN 16931");
    expect((form as FormData | null)?.get("facturxDocumentType")).toBe("INVOICE");
    expect((form as FormData | null)?.get("facturxVersion")).toBe("1.0");
    expect((form as FormData | null)?.get("pdfa")).toBe("PDF/A-3b");
    expect(((form as FormData | null)?.get("facturxXml") as File).name).toBe("factur-x.xml");
  });

  test("posts PDFs to the PDF engine merge endpoint in stable order", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const files: string[] = [];
    const result = await mergePdfsWithConfig(
      {
        files: [
          { pdf: new TextEncoder().encode("%PDF-one"), filename: "b.pdf" },
          { pdf: new TextEncoder().encode("%PDF-two"), filename: "a.pdf" },
        ],
      },
      baseConfig,
      {
        fetch: async (url, init) => {
          calls.push({ url: String(url), init: init ?? {} });
          for (const file of (init?.body as FormData).getAll("files")) {
            if (file instanceof File) files.push(file.name);
          }
          return pdfResponse("%PDF-merged");
        },
      },
    );

    expect(result.contentType).toBe("application/pdf");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://gotenberg:3000/forms/pdfengines/merge");
    expect(calls[0]?.init.method).toBe("POST");
    expect(files).toEqual(["000001.pdf", "000002.pdf"]);
  });

  test("rejects empty PDF merge input before making a request", async () => {
    let called = false;

    await expect(
      mergePdfsWithConfig({ files: [] }, baseConfig, {
        fetch: async () => {
          called = true;
          return pdfResponse();
        },
      }),
    ).rejects.toMatchObject({ code: "bad_input" });

    expect(called).toBe(false);
  });

  test("rejects oversized HTML before making a request", async () => {
    let called = false;

    await expect(
      renderHtmlToPdfWithConfig(
        { html: "abcdef" },
        { ...baseConfig, maxHtmlBytes: 5 },
        {
          fetch: async () => {
            called = true;
            return pdfResponse();
          },
        },
      ),
    ).rejects.toMatchObject({ code: "html_too_large" });

    expect(called).toBe(false);
  });

  test("rejects oversized PDF responses", async () => {
    await expect(
      renderHtmlToPdfWithConfig(
        { html: "<h1>Hello</h1>" },
        { ...baseConfig, maxPdfBytes: 5 },
        { fetch: async () => pdfResponse("123456") },
      ),
    ).rejects.toMatchObject({ code: "pdf_too_large" });
  });

  test("maps HTTP errors without exposing response bodies", async () => {
    await expect(
      renderHtmlToPdfWithConfig({ html: "<h1>Hello</h1>" }, baseConfig, {
        fetch: async () => new Response("internal secret details", { status: 500 }),
      }),
    ).rejects.toMatchObject({ code: "bad_response", status: 500 });
  });

  test("requires a configured URL", async () => {
    await expect(
      renderHtmlToPdfWithConfig({ html: "<h1>Hello</h1>" }, { ...baseConfig, url: "" }, { fetch: async () => pdfResponse() }),
    ).rejects.toBeInstanceOf(GotenbergRenderError);
  });
});
