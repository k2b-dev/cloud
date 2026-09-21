import { expect, test } from "bun:test";
import { AiTaskRequestSchema } from "@k2b/cloud/ai/browser";
import { chromium } from "playwright";
import type {} from "./ai-browser-harness";
import { compileArtifact } from "./compile";

test("opaque worker awaits AI beyond the startup watchdog and cancels server requests on stop", async () => {
  const build = Bun.spawn(
    ["bun", "build", new URL("./ai-browser-harness.ts", import.meta.url).pathname, "--target", "browser", "--format", "iife"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [harness, errors, exit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (exit) throw new Error(errors);
  const source = await compileArtifact({
    entry: "main.js",
    files: [
      {
        path: "main.js",
        content: `export default async () => ({
    text: await ai.generateText({prompt:"Summarize",input:"example"}),
    category: await ai.classify({prompt:"Classify",input:"example",choices:["a","b"]}),
    categories: await ai.classifyMany({prompt:"Classify",input:"example",choices:["a","b"]}),
    data: await ai.extractData({prompt:"Extract",input:"example",fields:[{name:"ready",type:"boolean",description:"Ready"}]})
  });`,
      },
    ],
  });
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      if (new URL(request.url).pathname !== "/ai")
        return new Response("<!doctype html><body></body>", { headers: { "Content-Type": "text/html" } });
      const input = AiTaskRequestSchema.parse(await request.json());
      calls++;
      if (calls === 1) await Bun.sleep(16000);
      return Response.json(
        input.kind === "generate_text"
          ? "Summary"
          : input.kind === "classify"
            ? "a"
            : input.kind === "classify_many"
              ? ["a"]
              : { ready: true },
      );
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.port}`);
    await page.addScriptTag({ content: harness });
    expect(await page.evaluate((source) => window.runAiScenario(source, false), source)).toEqual({
      text: "Summary",
      category: "a",
      categories: ["a"],
      data: { ready: true },
    });
    expect(calls).toBe(4);
    expect(await page.evaluate((source) => window.runAiScenario(source, true), source)).toEqual({ aborted: true, output: null });
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 45000);
