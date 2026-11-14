import { resolve } from "node:path";

const output = process.env.DIST_DIR;
if (!output) throw new Error("DIST_DIR is required");
for (const runner of [false, true]) {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../src/chat-code/runtime/worker.ts")],
    target: "browser",
    format: "iife",
    minify: true,
    define: { "import.meta.url": JSON.stringify("about:blank"), __CLOUD_CODE_RUNNER__: String(runner) },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  await Bun.write(
    resolve(output, runner ? "assistant-artifact-runner-worker.js" : "assistant-artifact-worker.js"),
    await build.outputs[0]!.text(),
  );
}

const chunks: Record<string, string> = {};
const prelude = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../src/chat-code/runtime/runner-worker.ts")],
  target: "browser",
  format: "esm",
  minify: true,
});
if (!prelude.success) throw new Error(prelude.logs.join("\n"));
await Bun.write(resolve(output, "assistant-artifact-runner-prelude.js"), await prelude.outputs[0]!.text());
for (const [name, entry] of Object.entries({
  csv: "sheet-lib.ts",
  sheet: "sheet-chunk.ts",
  finance: "finance-chunk.ts",
  "pdf-read": "pdf-reader.ts",
})) {
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, `../src/chat-code/runtime/${entry}`)],
    target: "browser",
    format: "esm",
    minify: true,
    define: { "import.meta.url": JSON.stringify("about:blank") },
  });
  if (!build.success) throw new Error(build.logs.join("\n"));
  const code = await build.outputs[0]!.text();
  const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex").slice(0, 16);
  const file = `assistant-artifact-${name}-${hash}.js`;
  await Bun.write(resolve(output, file), code);
  chunks[name] = file;
}
await Bun.write(resolve(output, "assistant-artifact-chunks.json"), JSON.stringify(chunks));

// PDF documents keep the shared stylesheet and fonts; rendering is owned by Gotenberg.
const { buildBaseCss } = await import("../src/chat-code/build-document-css");
await Bun.write(resolve(output, "assistant-app-base.css"), await buildBaseCss());
