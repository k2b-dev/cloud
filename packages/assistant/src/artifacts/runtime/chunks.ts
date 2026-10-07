import { env } from "@k2b/cloud/config";
import { z } from "zod";
export const ChunkName = z.enum(["sheet", "finance", "pdf-read"]);
export type ChunkName = z.infer<typeof ChunkName>;
export const chunkEntries = { sheet: "sheet-chunk.ts", finance: "finance-chunk.ts", "pdf-read": "pdf-reader.ts" };
const pending = new Map<ChunkName, Promise<string>>();
export function chunkSource(name: ChunkName): Promise<string> {
  let code = pending.get(name);
  if (!code) {
    code = (async () => {
      if (env.NODE_ENV === "production") {
        const manifest = z
          .record(ChunkName, z.string().regex(/^assistant-artifact-[a-z-]+-[a-f0-9]+\.js$/))
          .parse(await Bun.file(new URL("./assistant-artifact-chunks.json", import.meta.url)).json());
        return Bun.file(new URL(`./${manifest[name]}`, import.meta.url)).text();
      }
      const build = await Bun.build({
        entrypoints: [new URL(chunkEntries[name], import.meta.url).pathname],
        target: "browser",
        format: "esm",
        minify: true,
        define: { "import.meta.url": JSON.stringify("about:blank") },
      });
      if (!build.success) throw new Error(build.logs.join("\n"));
      return build.outputs[0]!.text();
    })().catch((error) => {
      pending.delete(name);
      throw error;
    });
    pending.set(name, code);
  }
  return code;
}
