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
export class AppStorage {
  constructor(
    private userId: string,
    private appId: string,
    private enabled: boolean,
  ) {}
  private async root(area: "kv" | "files") {
    if (!this.enabled) throw new Error("Local storage is disabled for this app");
    const root = await navigator.storage.getDirectory();
    const kit = await root.getDirectoryHandle("kit", { create: true });
    const project = await kit.getDirectoryHandle(encodeURIComponent(this.appId), { create: true });
    const app = await project.getDirectoryHandle(encodeURIComponent(this.userId), { create: true });
    return app.getDirectoryHandle(area, { create: true });
  }
  async clear() {
    try {
      const root = await navigator.storage.getDirectory();
      const kit = await root.getDirectoryHandle("kit");
      const app = await kit.getDirectoryHandle(encodeURIComponent(this.appId));
      await app.removeEntry(encodeURIComponent(this.userId), { recursive: true });
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    }
  }
  async call(method: string, args: unknown[]): Promise<unknown> {
    const kv = method.startsWith("store.");
    const root = await this.root(kv ? "kv" : "files");
    if (method === "store.keys" || method === "opfs.list") {
      const paths: string[] = [];
      const walk = async (dir: FileSystemDirectoryHandle, prefix = "") => {
        for await (const [name, h] of dir.entries()) {
          if (paths.length >= 1000) throw new Error("List exceeds 1000 entries");
          if (h.kind === "file") paths.push(kv ? decodeURIComponent(name) : prefix + name);
          else await walk(await dir.getDirectoryHandle(name), prefix + name + "/");
        }
      };
      await walk(root);
      return paths.sort();
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
