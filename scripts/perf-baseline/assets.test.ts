import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { compressedSizes, measureStatic, sumSizes } from "./assets";

describe("production build asset accounting", () => {
  test("compression matches the production settings and honors actual precompressed files", async () => {
    const source = Buffer.from("export const message = 'hello';\n".repeat(40));
    expect(await compressedSizes(source)).toEqual({
      raw: source.length,
      gzip: gzipSync(source, { level: constants.Z_BEST_COMPRESSION }).length,
      brotli: brotliCompressSync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } }).length,
    });
    expect(await compressedSizes(source, { gzip: new Uint8Array(7), brotli: new Uint8Array(4) })).toEqual({
      raw: source.length,
      gzip: 7,
      brotli: 4,
    });
    expect(
      sumSizes([
        { raw: 10, gzip: 8, brotli: 6 },
        { raw: 20, gzip: 12, brotli: 9 },
      ]),
    ).toEqual({ modules: 2, raw: 30, gzip: 20, brotli: 15 });
  });

  test("served URLs follow the versioned eager/lazy graph into flat output, including CSS imports", async () => {
    const root = new URL("../../.local/perf-baseline-tests/", import.meta.url).pathname;
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, "assets-"));
    try {
      const dist = join(directory, "faq", "dist");
      await mkdir(join(dist, "_ssr"), { recursive: true });
      await mkdir(join(dist, "public", "faq"), { recursive: true });
      const entries = {
        "entry.js": 'import "./shared.js";import("./lazy.js");',
        "shared.js": "export const x = 1;",
        "lazy.js": 'export {x} from "./shared.js";',
        "unused.js": "ignored",
      };
      for (const [file, source] of Object.entries(entries)) await writeFile(join(dist, "_ssr", file), source);
      await writeFile(join(dist, "_ssr", "entry.js.br"), new Uint8Array(5));
      await writeFile(join(dist, "public", "faq", "app.css"), '@import "./theme.css";body{color:red}');
      await writeFile(join(dist, "public", "faq", "theme.css"), "body{margin:0}");
      const html =
        '<html><solid-island data-id="entry" data-props="{}"></solid-island><script type="module">const p="/faq/_ssr/123";document.querySelectorAll("solid-island,solid-client").forEach(e=>import(p+"/"+e.dataset.id+".js"));</script><link rel="stylesheet" href="/public/faq/app.css"></html>';
      const result = await measureStatic(html, "http://127.0.0.1:4100/faq", directory, ["faq"]);
      expect(result.js.eager.modules).toBe(2);
      expect(result.js.lazy.modules).toBe(1);
      expect(result.js.eager.raw).toBe(Buffer.byteLength(entries["entry.js"] + entries["shared.js"]));
      expect(result.js.eager.brotli).toBe(5 + (await compressedSizes(Buffer.from(entries["shared.js"]))).brotli);
      expect(result.css.modules).toBe(2);
      expect(result.html.raw).toBe(Buffer.byteLength(html));
      await rm(join(dist, "_ssr", "shared.js"));
      expect(measureStatic(html, "http://127.0.0.1:4100/faq", directory, ["faq"])).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
