import { describe, expect, test, spyOn } from "bun:test";
import { PdfRequest, encodePdfRequest, decodePdfRequest } from "./pdf-contracts";
import { authorizePdf, executePdf, offlinePdfHtml, studioPdf } from "./pdf-service";
import { artifacts, ArtifactError } from "./service";
import { testIdentity } from "./test-identity";
import { createArtifactServiceRoutes } from "./api";
import { Hono } from "hono";
import type { AuthContext } from "@k2b/cloud/server";

const config = { url: "http://pdf.test", timeoutMs: 1000, maxHtmlBytes: 1024 * 1024, maxPdfBytes: 1024 * 1024 };

test("PDF multipart roundtrip preserves binary bytes, types and metadata", async () => {
  const source = { operation: "attach", document: new Blob(["%PDF-document"]), attachments: [{ name: "invoice.xml", data: new Blob([new Uint8Array([0, 255, 17])], { type: "application/xml" }), relationship: "Data" }] };
  const form = await new Response(encodePdfRequest(source)).formData();
  const request = decodePdfRequest(form);
  expect(request.operation).toBe("attach");
  if (request.operation !== "attach") throw new Error("Unexpected operation");
  expect(request.attachments[0]!.relationship).toBe("Data");
  expect(request.attachments[0]!.data.type).toBe("application/xml");
  expect(new Uint8Array(await request.attachments[0]!.data.arrayBuffer())).toEqual(new Uint8Array([0, 255, 17]));
  expect(await request.document.text()).toBe("%PDF-document");
});

test("HTML render forwards page options, assets, tagging and offline policy", async () => {
  await executePdf({ operation: "render", html: '<style>h1{color:red}</style><h1>Hello</h1>', assets: [{ name: "logo.png", data: new Blob(["png"]) }], page: { format: "A5", landscape: true, margin: { top: 10 } } }, config, {
    fetch: async (url, init) => {
      expect(String(url)).toEndWith("/forms/chromium/convert/html");
      const form = init!.body as FormData;
      expect(form.get("paperWidth")).toBe(String(148 / 25.4));
      expect(form.get("landscape")).toBe("true");
      expect(form.get("marginTop")).toBe(String(10 / 25.4));
      expect(form.get("generateTaggedPdf")).toBe("true");
      expect(form.get("preferCssPageSize")).toBe("false");
      const files = form.getAll("files") as File[];
      expect(files.map(file => file.name)).toEqual(["index.html", "logo.png"]);
      expect(await files[0]!.text()).toContain("default-src 'none'");
      expect(await files[0]!.text()).toContain("h1{color:red}");
      return new Response("%PDF-ok", { headers: { "Content-Type": "application/pdf" } });
    },
  });
});

test("offline HTML removes redirect and executable document elements", async () => {
  const html = await offlinePdfHtml('<META http-equiv="refresh" content="0;url=http://private"><base href="http://private/"><script>fetch("http://private")</script><iframe src="http://private"></iframe><p>Invoice</p>');
  expect(html).not.toContain("http://private");
  expect(html).toContain("<p>Invoice</p>");
  expect(html).toContain("form-action 'none'");
});

test("PDF rejects unsupported options, asset collisions and configured byte overflows", async () => {
  await expect(executePdf({ operation: "render", html: "<script>" + "x".repeat(2048) + "</script>" }, { ...config, maxHtmlBytes: 1024 })).rejects.toMatchObject({ code: "html_too_large" });
  expect(PdfRequest.safeParse({ operation: "render", html: "hi", page: { format: "nope" } }).success).toBe(false);
  expect(PdfRequest.safeParse({ operation: "attach", document: new Blob(), attachments: [{ name: "../x", data: new Blob() }] }).success).toBe(false);
  await expect(executePdf({ operation: "render", html: "hi", assets: [{ name: "index.html", data: new Blob() }] }, config)).rejects.toMatchObject({ code: "bad_input" });
  await expect(executePdf({ operation: "attach", document: new Blob(["12345"]), attachments: [{ name: "x.xml", data: new Blob(["67890"]) }] }, { ...config, maxPdfBytes: 9 })).rejects.toMatchObject({ code: "pdf_too_large" });
});

test("PDF output is bounded while streaming and cancels upstream on overflow", async () => {
  let cancelled = false;
  await expect(executePdf({ operation: "render", html: "hi" }, { ...config, maxPdfBytes: 4 }, {
    fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } }), { headers: { "Content-Type": "application/pdf" } }),
  })).rejects.toMatchObject({ code: "pdf_too_large" });
  expect(cancelled).toBe(true);
});

test("PDF cancellation reaches the configured upstream fetch", async () => {
  const abort = new AbortController();
  const operation = executePdf({ operation: "render", html: "hi" }, config, {
    signal: abort.signal,
    fetch: async (_url, init) => {
      abort.abort();
      expect(init!.signal!.aborted).toBe(true);
      init!.signal!.throwIfAborted();
      throw new Error("unreachable");
    },
  });
  await expect(operation).rejects.toMatchObject({ code: "timeout" });
});

test("runtime PDF authorizes Use access without asking for Manage", async () => {
  const identity = testIdentity("00000000-0000-4000-8000-000000000001");
  const get = spyOn(artifacts, "get").mockResolvedValue({ id: "ABC234", kind: "app", title: "Shared app", permission: "read", revision: 1, sourceRevision: 1, publishedRevision: 1, updatedAt: "2026-09-15T00:00:00Z", forkedFromId: null, forkedFromRevision: null, source: { entry: "main.js", files: [{ path: "main.js", content: "export default()=>{}" }] } });
  try {
    await authorizePdf({ resourceId: "ABC234" }, identity);
    expect(get).toHaveBeenCalledWith("ABC234", { ...identity, conversationId: undefined });
    get.mockRejectedValue(new ArtifactError("ACCESS_DENIED"));
    await expect(authorizePdf({ resourceId: "ABC234" }, identity)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  } finally { get.mockRestore(); }
});

test("runtime PDF denies before parsing or executing and returns binary PDF on success", async () => {
  const identity = testIdentity("00000000-0000-4000-8000-000000000001");
  const routes = new Hono<AuthContext>().use("*", async (c, next) => { c.set("actor", identity.actor); c.set("accessSubject", identity.accessSubject); await next(); }).route("/", createArtifactServiceRoutes());
  const access = spyOn(studioPdf, "authorize").mockRejectedValue(new ArtifactError("ACCESS_DENIED"));
  const execute = spyOn(studioPdf, "execute").mockResolvedValue({ pdf: new TextEncoder().encode("%PDF-output"), contentType: "application/pdf" });
  try {
    const denied = await routes.request("/runtime/pdf?resourceId=ABC234", { method: "POST", body: "not multipart" });
    expect(denied.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
    access.mockResolvedValue(undefined);
    const response = await routes.request("/runtime/pdf?resourceId=ABC234", { method: "POST", body: encodePdfRequest({ operation: "render", html: "hello" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.text()).toBe("%PDF-output");
  } finally { access.mockRestore(); execute.mockRestore(); }
});
