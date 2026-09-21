import { z } from "zod";
import { LIMITS } from "../contracts";
export const StoragePage = z.object({ after: z.string().max(240).default(""), limit: z.number().int().min(1).max(1000).default(1000) });
const STORAGE_BYTES = 16 * 1024 * 1024;
function segments(path: unknown) {
  if (
    typeof path !== "string" ||
    path.length > 240 ||
    !path ||
    path.split("/").some((s) => !s || s === "." || s === ".." || /[\\\x00]/.test(s))
  )
    throw new Error("Invalid local path");
  return path.split("/");
}
export class ArtifactStorage {
  constructor(
    private userId: string,
    private artifactId: string,
  ) {}
  private async root(area: "kv" | "files") {
    const root = await navigator.storage.getDirectory();
    const artifacts = await root.getDirectoryHandle("assistant-artifacts", { create: true });
    const project = await artifacts.getDirectoryHandle(encodeURIComponent(this.artifactId), { create: true });
    const app = await project.getDirectoryHandle(encodeURIComponent(this.userId), { create: true });
    return app.getDirectoryHandle(area, { create: true });
  }
  async clear() {
    try {
      const root = await navigator.storage.getDirectory();
      const artifacts = await root.getDirectoryHandle("assistant-artifacts");
      const app = await artifacts.getDirectoryHandle(encodeURIComponent(this.artifactId));
      await app.removeEntry(encodeURIComponent(this.userId), { recursive: true });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    }
  }
  async call(method: string, args: unknown[]): Promise<unknown> {
    const kv = method.startsWith("store.");
    const root = await this.root(kv ? "kv" : "files");
    if (method === "store.keys" || method === "opfs.list") {
      const page = StoragePage.parse(args[0] ?? {});
      const paths: string[] = [];
      let metadataBytes = 0;
      const walk = async (dir: FileSystemDirectoryHandle, prefix = "") => {
        for await (const [name, h] of dir.entries()) {
          if (h.kind === "file") {
            const path = kv ? decodeURIComponent(name) : prefix + name;
            if (path <= page.after) continue;
            metadataBytes += new TextEncoder().encode(JSON.stringify(path)).byteLength;
            if (metadataBytes > LIMITS.rpcBytes)
              throw new Error("Local listing exceeds metadata budget; organize files into smaller resources");
            paths.push(path);
          } else await walk(await dir.getDirectoryHandle(name), prefix + name + "/");
        }
      };
      await walk(root);
      return paths.sort().slice(0, page.limit);
    }
    const parts = kv ? [encodeURIComponent(segments(args[0]).join("/"))] : segments(args[0]);
    const filename = parts.pop()!;
    let dir = root;
    const write = method === "store.set" || method === "opfs.write";
    try {
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: write });
      if (method.endsWith(".delete")) {
        await dir.removeEntry(filename);
        return null;
      }
      if (write) {
        const value = kv ? JSON.stringify(args[1]) : args[1];
        if (typeof value !== "string" && !(value instanceof Blob)) throw new Error("Expected text or Blob");
        const blob = typeof value === "string" ? new Blob([value]) : value;
        if (blob.size > STORAGE_BYTES) throw new Error("Local item exceeds 16 MiB");
        const file = await dir.getFileHandle(filename, { create: true });
        const out = await file.createWritable();
        try {
          await out.write(blob);
          await out.close();
        } catch (e) {
          await out.abort().catch(() => {});
          throw e;
        }
        return null;
      }
      const file = await (await dir.getFileHandle(filename)).getFile();
      return kv ? JSON.parse(await file.text()) : file;
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") return null;
      throw e;
    }
  }
}
