import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { compileArtifact } from "./compile";
import type {} from "./streams-browser-harness";

test("isolated code worker transfers a 5 MiB file and rejects unissued or changed stream references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-stream-browser-"));
  let harness: string;
  try {
    const output = join(directory, "harness.js");
    const build = Bun.spawn(
      [
        "bun",
        "build",
        new URL("./streams-browser-harness.ts", import.meta.url).pathname,
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
    harness = await Bun.file(output).text();
  } finally {
    await rm(directory, { recursive: true });
  }
  const source = await compileArtifact({
    entry: "main.js",
    files: [
      {
        path: "main.js",
        content: `export default async()=>{
    const source=await capabilities.run("independent.audio.read");
    const file=await capabilities.streams.read(source.stream);
    const target=await capabilities.run("independent.archive.import");
    const saved=await capabilities.streams.write(target.stream,file);
    const status=await capabilities.streams.status(target.stream);
    const rejected=[];
    for(const ref of [{...source.stream,id:"forged"},{...source.stream,size:1}]){
      try {await capabilities.streams.read(ref);}catch(e){rejected.push(e.message);}
    }
    return {size:file.size,saved:saved.data.saved,state:status.state,rejected};
  }`,
      },
    ],
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("<!doctype html><body></body>", { headers: { "content-type": "text/html" } }),
  });
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.addScriptTag({ content: harness });
    const result = await page.evaluate((source) => runStreamScenario(source), source);
    expect(result.uploaded).toBe(5 * 1024 * 1024);
    expect(result.state.output).toEqual({
      size: 5 * 1024 * 1024,
      saved: true,
      state: "completed",
      rejected: ["Stream was not issued to this run", "Stream was not issued to this run"],
    });
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60_000);
