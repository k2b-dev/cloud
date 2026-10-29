/** Local fictional fixture; --help prints usage, Ctrl-C stops its server. */
if (process.argv.includes("--help")) {
  console.log("bun packages/ui/test/text-editor-preview.ts [port] — fictional editor preview on loopback");
  process.exit(0);
}
const build = await Bun.build({
  entrypoints: [new URL("./text-editor-component-harness.ts", import.meta.url).pathname],
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs);
const js = await build.outputs[0]!.text();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv[2] ?? 0),
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/editor.js") return new Response(js, { headers: { "content-type": "application/javascript" } });
    if (path.startsWith("/assets/")) {
      const name = path.slice(8);
      if (!/^[\w.-]+$/.test(name)) return new Response(null, { status: 404 });
      return new Response(Bun.file(new URL(`../dist/${name}`, import.meta.url)));
    }
    return new Response(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/global.css"><style>body{margin:0}.fixture{max-width:1000px;margin:24px auto;padding:20px 32px;background:var(--k2b-surface);border-radius:16px;min-height:750px}h1{font-size:18px}#root{max-width:760px}@media(max-width:767px){.fixture{margin:0;padding:16px;border-radius:0}}</style></head><body class="k2b-ui"><main class="fixture"><h1>Re: Angebot Visitenkarten 2026</h1><div id="root"></div></main><script src="/editor.js"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
console.log(server.url.href);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    server.stop(true);
    process.exit(0);
  });
