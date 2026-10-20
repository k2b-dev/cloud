import { basename, resolve } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { buildIslandClosure } from "./island-closure";

/** One split production build, counting each eagerly reachable output once, without dynamic-import edges. */
export async function islandBundleSize(entries: string[]) {
  const build = await buildIslandClosure(entries);
  const meta = build.metafile;
  if (!meta) throw new Error("Missing island bundle metafile");
  const outputs = new Map(Object.entries(meta.outputs).map(([path, output]) => [basename(path), output]));
  const eagerChunks = new Set<string>();
  const visit = (path: string) => {
    const key = basename(path);
    if (eagerChunks.has(key)) return;
    const output = outputs.get(key);
    if (!output) throw new Error(`Missing island output ${path}`);
    eagerChunks.add(key);
    for (const edge of output.imports) if (edge.kind !== "dynamic-import") visit(edge.path);
  };
  const entryPaths = new Set(entries.map((entry) => resolve(entry)));
  for (const [path, output] of outputs) if (output.entryPoint && entryPaths.has(resolve(output.entryPoint))) visit(path);
  if (!eagerChunks.size) throw new Error("No island entries found in bundle outputs");
  const eagerInputs = new Set<string>();
  const allInputs = new Set<string>();
  for (const [path, output] of outputs)
    for (const [input, details] of Object.entries(output.inputs)) {
      if (!details.bytesInOutput) continue;
      allInputs.add(input);
      if (eagerChunks.has(path)) eagerInputs.add(input);
    }
  let eagerBrotliBytes = 0;
  for (const output of build.outputs)
    if (eagerChunks.has(basename(output.path)) && output.path.endsWith(".js"))
      eagerBrotliBytes += brotliCompressSync(new Uint8Array(await output.arrayBuffer()), {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
      }).byteLength;
  return {
    eagerBrotliBytes,
    eagerInputs: [...eagerInputs].sort(),
    dynamicInputs: [...allInputs].filter((input) => !eagerInputs.has(input)).sort(),
    eagerChunks: [...eagerChunks].sort(),
  };
}
