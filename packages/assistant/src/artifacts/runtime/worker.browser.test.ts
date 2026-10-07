import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type {} from "./browser-harness";
import { ChunkName, chunkSource } from "./chunks";
import { compileArtifact } from "./compile";

test("real opaque worker returns data, reads inputs, captures downloads and remains terminable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-worker-test-"));
  const output = join(directory, "harness.js");
  const build = Bun.spawn(
    [
      "bun",
      "build",
      new URL("./browser-harness.ts", import.meta.url).pathname,
      "--target",
      "browser",
      "--format",
      "iife",
      "--outfile",
      output,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const harness = await Bun.file(output).text();
  await rm(directory, { recursive: true });
  const compile = (content: string) => compileArtifact({ entry: "main.js", files: [{ path: "main.js", content }] });
  const uiSource = await compile("export default () => typeof ui;");
  const invalidEntrySource = await compile("export default { answer: 42 };");
  const undefinedOutputSource = await compile("export default () => ({missingColumn:undefined});");
  const headlessSource = await compile("export default () => ({ answer: 42 });");
  const csvSource = await compile(`export default async (_input, {files,signal,progress}) => {
    for(let i=0;i<250;i++) console.info("row",i);
    console.error("late diagnostic");
    const totals = {};
    for (const input of files) {
      for (const row of await cloud.sheet.parseCsv(await input.file(), {delimiter:","})) {
        totals[row.name] = (totals[row.name] || 0) + Number(row.amount);
      }
    }
    await cloud.download("totals.csv", await cloud.sheet.toCsv(Object.entries(totals).map(([name,amount]) => ({name,amount}))));
    return {people: Object.keys(totals).length, total: Object.values(totals).reduce((a,b)=>a+b,0)};
  };`);
  const errorSource = await compile('export default () => { throw new Error("deliberate"); };');
  const infiniteSource = await compile("export default () => { while(true){} };");
  const sessionSource = await compile(`export default async (_input, {files,signal,progress}) => {
    const before = await cloud.kv.user.get("count");
    await cloud.kv.user.set("count", 3);
    const input = await files[0].file();
    await cloud.download("copy.csv", await input.text());
    return {before, count:await cloud.kv.user.get("count")};
  };`);
  const agentSource = await compile("export default () => ({ answer: 42 });");
  const pdfBytes = Buffer.from(await Bun.file(new URL("./fixtures/invoice.pdf", import.meta.url)).arrayBuffer()).toString("base64");
  const xlsxBytes = Buffer.from(await Bun.file(new URL("./fixtures/ledger.xlsx", import.meta.url)).arrayBuffer()).toString("base64");
  const documentsSource = await compile(`export default async (_input, {files,signal,progress}) => {
    const blob = b64 => new Blob([Uint8Array.from(atob(b64), c=>c.charCodeAt(0))]);
    const document = await cloud.pdf.read(blob(${JSON.stringify(pdfBytes)}));
    const page = await document.page(1);
    await document.close();
    const workbook = await cloud.sheet.read(blob(${JSON.stringify(xlsxBytes)}), {numbers:"string"});
    const names = workbook.sheetNames;
    const rows = workbook.rows(names[0]);

    const failures = [];
    for (const read of [() => document.page(1),
      () => cloud.pdf.read(new Blob(["invalid pdf"])), () => cloud.sheet.read(new Blob(["not zip"]))]) {
      try { await read(); failures.push("unexpected success"); } catch (error) { failures.push(error.message); }
    }
    const malicious = new Uint8Array(await blob(${JSON.stringify(xlsxBytes)}).arrayBuffer());
    const zip = new DataView(malicious.buffer);
    for (let i=0;i<malicious.length-46;i++) if(zip.getUint32(i,true)===0x02014b50) {
      zip.setUint32(i+24,129*1024*1024,true); break;
    }
    try { await cloud.sheet.read(new Blob([malicious])); failures.push("unexpected success"); }
    catch (error) { failures.push(error.message); }
    return {page, names, rows, failures};
  };`);
  const workSource = await compile(`export default async (_input,{signal,progress}) => {
    for(let i=0;i<17;i++) {
      signal.throwIfAborted(); progress(i,17,"Processing");
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    progress(17,17); return "finished";
  };`);
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const prefix = "/api/assistant/artifacts/runtime/chunks/";
      if (path.startsWith(prefix)) {
        const name = ChunkName.safeParse(path.slice(prefix.length));
        return name.success
          ? new Response(await chunkSource(name.data), { headers: { "Content-Type": "text/javascript" } })
          : new Response("Unknown runtime library", { status: 404 });
      }
      return new Response("<!doctype html><body></body>", { headers: { "Content-Type": "text/html" } });
    },
  });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.addScriptTag({ content: harness });
    expect(await page.evaluate(() => runArtifactStoragePages())).toEqual({
      counts: [500, 500, 5],
      unique: 1005,
      first: "file-00000.txt",
      last: "file-01004.txt",
    });
    const encoded = await compile(`export default async (_input, {files,signal,progress}) =>{
      const file=new File([new Uint8Array([110,97,109,101,59,97,109,111,117,110,116,10,77,252,108,108,101,114,59,52,50])],"legacy.csv");
      let rejected=false;try{await cloud.sheet.parseCsv(file);}catch{rejected=true;}
      return {rejected,rows:await cloud.sheet.parseCsv(file,{encoding:"windows-1252"}),single:await cloud.sheet.parseCsv("amount\\n42")};
    }`);
    const decoded = await page.evaluate((source) => runArtifactScenario({ source }), encoded);
    expect(decoded.errors).toEqual([]);
    expect(decoded.output).toEqual({ rejected: false, rows: [{ name: "Müller", amount: 42 }], single: [{ amount: 42 }] });
    const largeCsv = await compile(`export default async (_input, {files,signal,progress}) =>{
      const text="month;amount;description\\n"+("2026-01;42;"+"x".repeat(70)+"\\n").repeat(500000);
      const start=performance.now();const rows=await cloud.sheet.parseCsv(text);let sum=0;
      for(let i=0;i<rows.length;i++) {
        signal.throwIfAborted();sum+=Number(rows[i].amount);
        if(i%5000===0){progress(i,rows.length);await new Promise(resolve=>setTimeout(resolve,0));}
      }
      return {bytes:text.length,rows:rows.length,sum,elapsedMs:performance.now()-start};
    }`);
    const large = await page.evaluate((source) => runArtifactScenario({ source }), largeCsv);
    expect(large.errors).toEqual([]);
    expect(large.output).toMatchObject({ rows: 500000, sum: 21000000 });
    console.info("Large CSV browser measurement", large.output);
    const headless = await page.evaluate((source) => runArtifactScenario({ source }), headlessSource);
    expect(headless.errors).toEqual([]);
    expect(headless.output).toEqual({ answer: 42 });
    expect(headless.errors).toEqual([]);
    const documents = await page.evaluate((source) => runArtifactScenario({ source }), documentsSource);
    expect(documents.errors).toEqual([]);
    expect(documents.output).toMatchObject({
      page: { page: 1, width: 612, height: 792 },
      names: ["Ledger"],
      rows: [
        ["Reference", "Amount"],
        ["DHL-001", "12.34"],
        ["Cached formula", "24.68"],
      ],
    });
    expect(JSON.stringify(documents.output)).toContain("DHL-001 EUR 12.34");
    expect(documents.output).toMatchObject({
      failures: ["PDF is closed", expect.any(String), expect.stringContaining("XLSX ZIP"), expect.stringContaining("128 MiB")],
    });
    expect(JSON.stringify(documents.output)).not.toContain("unexpected success");
    const jobs = await page.evaluate((source) => runArtifactWorkScenario(source), workSource);
    expect(jobs.finished.work?.status).toBe("completed");
    expect(jobs.finished.output).toBe("finished");
    expect(jobs.cancelled.work?.status).toBe("cancelled");
    const csv = await page.evaluate((source) => runArtifactCsvScenario(source), csvSource);
    expect(csv.state.output).toEqual({ people: 2, total: 25 });
    expect(csv.state.logs).toHaveLength(200);
    expect(csv.state.logs.at(-1)?.text).toBe("late diagnostic");
    expect(csv.content).toContain("Alice;17");
    expect(csv.content).toContain("Bob;8");
    const ui = await page.evaluate((source) => runArtifactScenario({ source }), uiSource);
    // Scripts have no UI tree anymore; interfaces are HTML apps.
    expect(ui.output).toBe("undefined");
    const failure = await page.evaluate((source) => runArtifactScenario({ source }), errorSource);
    expect(failure.errors.join(" ")).toContain("deliberate");
    const invalidEntry = await page.evaluate((source) => runArtifactScenario({ source }), invalidEntrySource);
    expect(invalidEntry.errors.join(" ")).toContain("must default-export a function");
    const undefinedOutput = await page.evaluate((source) => runArtifactScenario({ source }), undefinedOutputSource);
    expect(undefinedOutput.errors.join(" ")).toContain("Replace undefined values with null");
    const infinite = await page.evaluate((source) => runArtifactScenario({ source, stopAfterMs: 150 }), infiniteSource);
    expect(infinite.responsive).toBe(true);
    expect(infinite.stopped).toBe(true);
    for (let iteration = 0; iteration < 2; iteration++) {
      const session = await page.evaluate((source) => runArtifactSessionScenario(source), sessionSource);
      expect(session.state.output).toEqual({ before: null, count: 3 });
      expect(session.content).toBe("name\nAlice");
      expect(session.state.files[0]?.name).toBe("copy.csv");
    }
    const agent = await page.evaluate((source) => runArtifactAgentScenario(source), agentSource);
    expect(agent[0]).toMatchObject({ runId: "start", status: "ready", output: '{"answer":42}' });
    expect(agent[1]).toMatchObject({ runId: "start", status: "ready" });
    expect(agent[2]).toEqual({ runId: "start", stopped: true });
    expect(agent[3]).toHaveLength(1);
    // code_present rejects static problems before saving anything, and saves one-off files otherwise.
    const rejected = agent[4] as { failed: boolean; error: string };
    expect(rejected.failed).toBe(true);
    expect(rejected.error).toContain("<h1 onclick> never runs");
    expect(rejected.error).toContain("cdn.example.com");
    expect(agent[5]).toMatchObject({ title: "Overview", userVisible: true });
    expect(agent[6]).toEqual([
      expect.objectContaining({ title: "Overview", files: expect.arrayContaining([expect.objectContaining({ path: "index.html" })]) }),
    ]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
  // Includes a deliberate 17s progress job.
}, 180000);
