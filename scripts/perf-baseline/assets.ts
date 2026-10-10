import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { assetPath, type Bytes, closure, type Imports, inspectHtml, type StaticMetrics } from "./model";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Matches packages/cloud/scripts/build.ts; sidecars represent actual asset compression. */
export async function compressedSizes(source: Uint8Array, precompressed?: { gzip?: Uint8Array; brotli?: Uint8Array }): Promise<Bytes> {
  const [gzipBytes, brotliBytes] = await Promise.all([
    precompressed?.gzip ?? gz(source, { level: constants.Z_BEST_COMPRESSION }),
    precompressed?.brotli ?? brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } }),
  ]);
  return { raw: source.byteLength, gzip: gzipBytes.byteLength, brotli: brotliBytes.byteLength };
}

export function sumSizes(sizes: Bytes[]): Bytes & { modules: number } {
  return sizes.reduce<Bytes & { modules: number }>(
    (total, size) => ({
      modules: total.modules + 1,
      raw: total.raw + size.raw,
      gzip: total.gzip + size.gzip,
      brotli: total.brotli + size.brotli,
    }),
    { modules: 0, raw: 0, gzip: 0, brotli: 0 },
  );
}

export async function measureStatic(html: string, url: string, buildRoot: string, apps: string[]): Promise<StaticMetrics> {
  const info = await inspectHtml(html, url);
  const graph = new Map<string, Imports>();
  const sizes = new Map<string, Bytes>();
  const scanner = new Bun.Transpiler({ loader: "js" });
  const readAsset = async (path: string) => {
    const asset = assetPath(path, apps);
    const file = join(buildRoot, asset.app, "dist", asset.file);
    const source = await readFile(file);
    sizes.set(
      path,
      await compressedSizes(source, {
        gzip: existsSync(`${file}.gz`) ? await readFile(`${file}.gz`) : undefined,
        brotli: existsSync(`${file}.br`) ? await readFile(`${file}.br`) : undefined,
      }),
    );
    return source.toString("utf8");
  };
  const resolveImport = (path: string, parent: string) => {
    if (!path.startsWith(".") && !path.startsWith("/")) throw new Error(`Non-local module import in ${parent}: ${path}`);
    const imported = new URL(path, new URL(parent, url));
    if (imported.origin !== new URL(url).origin) throw new Error(`External module in ${parent}`);
    return imported.pathname;
  };
  const pending = [...info.modules, ...info.lazyModules];
  for (let index = 0; index < pending.length; index++) {
    const path = pending[index];
    if (path === undefined || graph.has(path)) continue;
    const source = await readAsset(path);
    const imports: Imports = { eager: [], lazy: [] };
    for (const item of scanner.scanImports(source)) {
      const dependency = resolveImport(item.path, path);
      (item.kind === "dynamic-import" ? imports.lazy : imports.eager).push(dependency);
    }
    graph.set(path, imports);
    pending.push(...imports.eager, ...imports.lazy);
  }
  const css = new Set<string>();
  const styles = [...info.css];
  for (let index = 0; index < styles.length; index++) {
    const path = styles[index];
    if (path === undefined || css.has(path)) continue;
    css.add(path);
    const source = await readAsset(path);
    for (const match of source.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/g)) {
      if (match[1]) styles.push(resolveImport(match[1], path));
    }
  }
  const sum = (paths: string[]) =>
    sumSizes(
      paths.map((path) => {
        const size = sizes.get(path);
        if (!size) throw new Error(`Missing size for ${path}`);
        return size;
      }),
    );
  const js = closure(info.modules, graph, info.lazyModules);
  return {
    html: await compressedSizes(Buffer.from(html)),
    islands: info.islands,
    islandEntries: info.islandEntries.length,
    propsBytes: info.propsBytes,
    propsShare: Number(info.propsShare.toFixed(6)),
    js: { eager: sum(js.eager), lazy: sum(js.lazy) },
    css: sum([...css]),
  };
}
