import { expect, test } from "bun:test";
import { PDFDocument } from "pdf-lib";
import { chromium } from "playwright";
import { decodePdfRequest } from "../pdf-contracts";
import { invoice } from "../test-invoice";
import { ChunkName, chunkSource } from "./chunks";
import { compileArtifact } from "./compile";
import type {} from "./pdf-browser-harness";

test("opaque Studio worker offers pure JS finance, PDF transport and cancellation", async () => {
  const build = Bun.spawn(
    ["bun", "build", new URL("./pdf-browser-harness.ts", import.meta.url).pathname, "--target", "browser", "--format", "iife"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [harness, errors, exit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (exit) throw new Error(errors);
  const code = await compileArtifact({
    entry: "main.js",
    files: [
      {
        path: "main.js",
        content: `export default async (_input, {files,signal,progress}) => {
    const invoice = ${JSON.stringify(invoice)};
    const model = await cloud.finance.einvoice.validate(invoice); if (!model.ok) throw new Error(JSON.stringify(model));
    const xml = await cloud.finance.einvoice.serialize(model.data, {format:"zugferd-2.5-en16931"}); if (!xml.ok) throw new Error(JSON.stringify(xml));
    const document = await cloud.pdf.render({html:"<h1>Invoice TEST-42</h1>",facturX:{xml:xml.data.xml,profile:"EN 16931"}});
    const parsed = await cloud.finance.einvoice.parsePdf(document);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    const rendered = await cloud.pdf.render({html:"<style>h1{color:red}</style><h1>Invoice</h1>"});
    const attached = await cloud.pdf.attach({document:rendered,attachments:[{name:"details.xml",data:new Blob([xml.data.xml],{type:"application/xml"}),relationship:"Data"}]});
    const abort = new AbortController();
    const pending = cloud.pdf.render({html:"slow"},{signal:abort.signal});
    setTimeout(()=>abort.abort(),150);
    let cancelled = false; try {await pending;} catch(error){cancelled=error.name === "CloudError" && error.code === "cancelled";}
    const next = await cloud.pdf.render({html:"after cancellation"});
    return {number:parsed.data.invoice.number,valid:model.ok,xml:(await cloud.finance.einvoice.parseXml(xml.data.xml)).ok,
      calculation:(await cloud.finance.einvoice.calculate(invoice.lines)).ok,invalidCamt:(await cloud.finance.camt.parse("<bad/>")).ok,
      existing:[typeof cloud.money.sum,typeof cloud.finance.datev.serialize,typeof cloud.finance.sepa.serialize],pdf:document.type,
      bytes:attached.size,cancelled,after:next.size};
  }`,
      },
    ],
  });
  let calls = 0,
    stopped = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const name = ChunkName.safeParse(new URL(request.url).pathname.split("/chunks/")[1]);
      if (name.success) return new Response(await chunkSource(name.data), { headers: { "Content-Type": "text/javascript" } });
      if (new URL(request.url).pathname !== "/pdf")
        return new Response("<!doctype html><body></body>", { headers: { "Content-Type": "text/html" } });
      const input = decodePdfRequest(await request.formData());
      calls++;
      if (input.operation !== "attach" && input.html === "slow") {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener(
            "abort",
            () => {
              stopped = true;
              resolve();
            },
            { once: true },
          );
          setTimeout(resolve, 3000);
        });
        return new Response("cancelled", { status: 499 });
      }
      const pdf = await PDFDocument.create();
      pdf.addPage();
      if (input.operation === "facturX")
        await pdf.attach(new TextEncoder().encode(input.xml), "factur-x.xml", { mimeType: "application/xml" });
      return new Response(new Uint8Array(await pdf.save()), { headers: { "Content-Type": "application/pdf" } });
    },
  });
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.addScriptTag({ content: harness });
    const result = await page.evaluate((source) => runPdfScenario(source), code);
    expect(result).toMatchObject({
      number: "TEST-42",
      valid: true,
      xml: true,
      calculation: true,
      invalidCamt: false,
      existing: ["function", "function", "function"],
      pdf: "application/pdf",
      cancelled: true,
      bytes: expect.any(Number),
      after: expect.any(Number),
    });
    expect(calls).toBe(5);
    expect(stopped).toBe(true);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60000);
