import { z } from "zod";

// Compare the files TypeScript reads, rather than gzip headers, source maps or
// README changes. UI ships declarations; SSR and Editor ship TypeScript source.
const publicManifest = z.object({
  type: z.string().optional(),
  main: z.string().optional(),
  module: z.string().optional(),
  types: z.string().optional(),
  exports: z.unknown().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  peerDependenciesMeta: z.unknown().optional(),
});

export const packedTypeSurface = async (archive: string): Promise<string> => {
  const files = await new Bun.Archive(await Bun.file(archive).arrayBuffer()).files();
  const manifest = files.get("package/package.json");
  if (!manifest) throw new Error(`Packed package has no package.json: ${archive}`);
  const paths = [...files.keys()].filter((path) => /\.(?:ts|tsx|mts|cts)$/.test(path)).sort();
  if (paths.length === 0) throw new Error(`Packed package has no TypeScript surface: ${archive}`);
  const hash = new Bun.CryptoHasher("sha256");
  // Conditional exports resolve in declaration order, so preserve object keys.
  hash.update(JSON.stringify(publicManifest.parse(await manifest.json())));
  for (const path of paths) {
    const file = files.get(path);
    if (!file) throw new Error(`Missing packed file: ${path}`);
    hash.update(JSON.stringify([path, await file.text()]));
  }
  return hash.digest("hex");
};

export const packedTypesMatch = async (workspaceArchive: string, publishedArchive: string): Promise<boolean> =>
  (await packedTypeSurface(workspaceArchive)) === (await packedTypeSurface(publishedArchive));
