import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { einvoice, type Invoice } from "@k2b/stdlib/finance";
import { PDFDocument } from "pdf-lib";
import { compileArtifact } from "./compile";
import { decodePdfRequest } from "../pdf-contracts";
import { executePdf } from "../pdf-service";
import type {} from "./pdf-browser-harness";

const invoice = {
  kind: "invoice", number: "TEST-42", invoiceDate: "2026-09-15", serviceDate: "2026-09-15", dueDate: "2026-09-30", currency: "EUR",
  seller: { name: "Example Seller", vatId: "DE123456789", address: { line1: "Street 1", city: "Ulm", postalCode: "89073", countryCode: "DE" } },
  buyer: { name: "Example Buyer", vatId: "DE987654321", address: { line1: "Street 2", city: "Berlin", postalCode: "10115", countryCode: "DE" } },
  buyerReference: "TEST", payment: { iban: "DE89370400440532013000", accountName: "Example Seller" },
  lines: [{ id: "1", name: "Service", quantity: "2.0000", unitPrice: "50.0000", unitCode: "HUR", taxRate: "19.00" }],
} satisfies Invoice;

test("opaque Studio worker offers pure JS finance, PDF transport and cancellation", async () => {
  const build = Bun.spawn(["bun", "build", new URL("./pdf-browser-harness.ts", import.meta.url).pathname, "--target", "browser", "--format", "iife"], { stdout: "pipe", stderr: "pipe" });
  const [harness, errors, exit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (exit) throw new Error(errors);
  const code = await compileArtifact({ entry: "main.js", files: [{ path: "main.js", content: `export default async () => {
    const invoice = ${JSON.stringify(invoice)};
    const model = einvoice.validate(invoice); if (!model.ok) throw new Error(JSON.stringify(model));
    const xml = einvoice.serialize(model.data, {format:"zugferd-2.5-en16931"}); if (!xml.ok) throw new Error(JSON.stringify(xml));
    const document = await pdf.facturX({html:"<h1>Invoice TEST-42</h1>",xml:xml.data.xml,profile:"EN 16931"});
    const parsed = await einvoice.parsePdf(new Uint8Array(await document.arrayBuffer()));
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    const rendered = await pdf.render({html:"<style>h1{color:red}</style><h1>Invoice</h1>"});
    const attached = await pdf.attach({document:rendered,attachments:[{name:"details.xml",data:new Blob([xml.data.xml],{type:"application/xml"}),relationship:"Data"}]});
    const abort = new AbortController();
    const pending = pdf.render({html:"slow"},{signal:abort.signal});
    setTimeout(()=>abort.abort(),150);
    let cancelled = false; try {await pending;} catch(error){cancelled=error.name === "AbortError";}
    const next = await pdf.render({html:"after cancellation"});
    return {number:parsed.data.invoice.number,valid:model.ok,xml:einvoice.parseXml(xml.data.xml).ok,
      calculation:einvoice.calculate(invoice.lines).ok,invalidCamt:camt.parse("<bad/>").ok,
      existing:[typeof money.sum,typeof datev.serialize,typeof sepa.serialize],pdf:document.type,
      bytes:attached.size,cancelled,after:next.size};
  }` }] });
  let calls = 0, stopped = false;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (new URL(request.url).pathname !== "/pdf") return new Response("<!doctype html><body></body>", { headers: { "Content-Type": "text/html" } });
    const input = decodePdfRequest(await request.formData());
    calls++;
    if (input.operation !== "attach" && input.html === "slow") {
      await new Promise<void>(resolve => { request.signal.addEventListener("abort", () => { stopped = true; resolve(); }, { once: true }); setTimeout(resolve, 3000); });
      return new Response("cancelled", { status: 499 });
    }
    const pdf = await PDFDocument.create(); pdf.addPage();
    if (input.operation === "facturX") await pdf.attach(new TextEncoder().encode(input.xml), "factur-x.xml", { mimeType: "application/xml" });
    return new Response(new Uint8Array(await pdf.save()), { headers: { "Content-Type": "application/pdf" } });
  } });
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href); await page.addScriptTag({ content: harness });
    const result = await page.evaluate(source => runPdfScenario(source), code);
    expect(result).toMatchObject({ number: "TEST-42", valid: true, xml: true, calculation: true, invalidCamt: false,
      existing: ["function", "function", "function"], pdf: "application/pdf", cancelled: true, bytes: expect.any(Number), after: expect.any(Number) });
    expect(calls).toBe(5);
    expect(stopped).toBe(true);
  } finally { await browser.close(); await server.stop(true); }
}, 60000);

(process.env.GOTENBERG_TEST_URL ? test : test.skip)("real Gotenberg renders offline HTML and roundtrips Factur-X and XML attachments", async () => {
  const config = { url: process.env.GOTENBERG_TEST_URL!, timeoutMs: 30000, maxHtmlBytes: 5 * 1024 * 1024, maxPdfBytes: 32 * 1024 * 1024 };
  let networkRequests = 0;
  const trap = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch() { networkRequests++; return new Response("unwanted outbound request"); } });
  const url = `http://host.docker.internal:${trap.port}`;
  try {
    const output = await executePdf({ operation: "render", html: `<meta http-equiv="refresh" content="0;url=${url}/redirect"><style>@import url('${url}/css'); h1{color:red}</style><img src="${url}/image"><script>fetch('${url}/js')</script><h1>Invoice</h1>`, page: { format: "A5" } }, config);
    const parsed = await PDFDocument.load(output.pdf);
    expect(parsed.getPages()).toHaveLength(1);
    expect(parsed.getPages()[0]!.getWidth()).toBeCloseTo(148 / 25.4 * 72, 0);
    expect(networkRequests).toBe(0);
    const xml = einvoice.serialize(invoice, { format: "zugferd-2.5-en16931" });
    if (!xml.ok) throw new Error(JSON.stringify(xml));
    const invoicePdf = await executePdf({ operation: "facturX", html: "<h1>Invoice TEST-42</h1>", xml: xml.data.xml, profile: "EN 16931" }, config);
    const result = await einvoice.parsePdf(invoicePdf.pdf);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.invoice.number).toBe("TEST-42");
    const attached = await executePdf({ operation: "attach", document: new Blob([new Uint8Array(output.pdf)]), attachments: [{ name: "factur-x.xml", data: new Blob([xml.data.xml], { type: "application/xml" }), relationship: "Alternative" }] }, config);
    expect((await einvoice.parsePdf(attached.pdf)).ok).toBe(true);
  } finally { await trap.stop(true); }
}, 60000);
