/** Read unchanged public invoices. Exit 1 means a compatibility gap, not a successful roundtrip. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deepStrictEqual, ok as assert } from "node:assert/strict";
import { SaxesParser } from "saxes";
import { einvoice } from "../src/finance";
import { validateInvoiceXml } from "../src/finance/validate";
import { validateInvoiceSchema } from "../src/finance/einvoice-validator";
import sources from "./einvoice-external-sources.json";
import expected from "./einvoice-external-expected.json";

// Same validator versions and hashes as finance-conformance.ts.
const validators = [
  { name: "saxon.jar", url: "https://repo.maven.apache.org/maven2/net/sf/saxon/Saxon-HE/10.9/Saxon-HE-10.9.jar", sha256: "491d8edf4ec811d15c2b2417b007218b9b938f15e4dfbad004025beb4e70e960" },
  { name: "cii.xslt", url: "https://raw.githubusercontent.com/ConnectingEurope/eInvoicing-EN16931/validation-1.3.16/cii/xslt/EN16931-CII-validation.xslt", sha256: "0b234dea2bbfee739b7761e607a992c17fab88773014ef56355b6158cfb1cc53" },
];
const cache = join(tmpdir(), "stdlib-finance-conformance");
await mkdir(cache, { recursive: true });
async function download(source: { name: string; url: string; sha256: string }) {
  const file = join(cache, `${source.sha256}-${source.name}`);
  if (!await Bun.file(file).exists()) {
    const response = await fetch(source.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Download failed: ${source.url}: ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error(`Download integrity failure: ${source.name}`);
    await Bun.write(file, bytes);
  }
  const bytes = await Bun.file(file).bytes();
  if (new Bun.CryptoHasher("sha256").update(bytes).digest("hex") !== source.sha256) throw new Error(`Cached integrity failure: ${source.name}`);
  return file;
}
const engines = await Promise.all(validators.map(download));
const originals = await Promise.all(sources.map(source => download({ ...source, name: `${source.name}.xml` })));
const work = await mkdtemp(join(tmpdir(), "stdlib-external-cii-"));
try {
  await mkdir(join(work, "originals"));
  await mkdir(join(work, "reports"));
  for (const [i, source] of sources.entries()) await Bun.write(join(work, "originals", `${source.name}.xml`), Bun.file(originals[i]!));
  const java = Bun.spawn(["java", "-jar", engines[0]!, `-s:${join(work, "originals")}`, `-xsl:${engines[1]!}`, `-o:${join(work, "reports")}`], { stdout: "inherit", stderr: "inherit" });
  if (await java.exited !== 0) throw new Error("Schematron engine failed; no conformance result can be claimed.");
  const results = [];
  for (const [i, source] of sources.entries()) {
    const xml = await Bun.file(originals[i]!).text();
    const report = await Bun.file(join(work, "reports", `${source.name}.xml`)).text();
    const failures: string[] = [];
    let svrl = false;
    const parser = new SaxesParser({ xmlns: true });
    parser.on("opentag", tag => {
      if (tag.uri !== "http://purl.oclc.org/dsdl/svrl") return;
      if (tag.local === "schematron-output") svrl = true;
      if (tag.local === "failed-assert") failures.push(tag.attributes.id?.value ?? "unknown");
    });
    parser.write(report).close();
    if (!svrl) throw new Error(`Missing SVRL report: ${source.name}`);
    // Raw XSD separately from the public API's profile restriction, including CIUS controls.
    const xsd = await validateInvoiceSchema(xml);
    const publicXsd = await validateInvoiceXml(xml, { format: "zugferd-2.5-en16931", mode: "incoming" });
    const reader = einvoice.parseXml(xml, { mode: "incoming" });
    if (reader.ok) {
      const invoice = reader.data.invoice, total = invoice.totals;
      // Golden values extracted independently with Python ElementTree from unchanged originals.
      const actual = { number: invoice.number, typeCode: invoice.typeCode, currency: invoice.currency,
        paymentCodes: invoice.payments.map(payment => payment.typeCode),
        totals: { net: total.netAmount, basis: total.taxBasisAmount, tax: total.taxAmount ?? null, gross: total.grossAmount, due: total.dueAmount,
          prepaid: total.prepaidAmount ?? null, allowances: total.allowanceAmount ?? null, charges: total.chargeAmount ?? null },
        groups: total.taxGroups.map(group => ({ category: group.taxCategory, rate: group.taxRate ?? null, reason: group.taxExemptionReason ?? null,
          code: group.taxExemptionReasonCode ?? null, net: group.netAmount, tax: group.taxAmount })),
        lines: invoice.lines.map(line => ({ id: line.id, quantity: line.quantity, unit: line.unitCode, price: line.unitPrice,
          basis: line.priceBasis?.quantity ?? null, net: line.netAmount, category: line.taxCategory, rate: line.taxRate ?? null })),
      };
      const golden = Object.entries(expected).find(([name]) => name === source.name)?.[1];
      assert(golden, `Missing expected values for ${source.name}`);
      deepStrictEqual(actual, golden, `Incorrect extracted data: ${source.name}`);
      deepStrictEqual([...new Set(total.taxGroups.map(group => group.taxCategory))].sort(), [...source.categories].sort());
      deepStrictEqual(reader.data.xml, xml);
      for (const line of invoice.lines) {
        const group = total.taxGroups.find(group => group.taxCategory === line.taxCategory && group.taxRate === line.taxRate);
        assert(group, `Missing group: ${source.name}/${line.id}`);
        deepStrictEqual(line.taxExemptionReason, group.taxExemptionReason);
        deepStrictEqual(line.taxExemptionReasonCode, group.taxExemptionReasonCode);
      }
    }
    results.push({ ...source, xsd: xsd.ok, schematronFailures: failures,
      publicXsd: publicXsd.ok ? "pass" : publicXsd.error.issues[0]?.message,
      reader: reader.ok ? "pass" : reader.error.issues[0]?.message,
      unmapped: reader.ok ? reader.data.unmapped.map(item => item.path) : undefined,
    });
    if (!xsd.ok || failures.length || !reader.ok || !publicXsd.ok) process.exitCode = 1;
  }
  console.log(JSON.stringify(results, null, 2));
  console.log(`Original invoices read: ${results.filter(row => row.reader === "pass").length}/${results.length}`);
} finally {
  await rm(work, { recursive: true, force: true });
}
