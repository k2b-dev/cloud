/** SHA-256 of the exact UTF-8 module delivered by Core. */
export const bundleHash = (source: string): string => new Bun.CryptoHasher("sha256").update(source).digest("hex");

/** Replica-local LRU only. Active loads are bounded by free slots; no filesystem or shared cache. */
export class BundleCache {
  #bytes = 0;
  #entries = new Map<string, string>();
  #loading = new Map<string, Promise<string>>();
  constructor(
    readonly maxBytes: number,
    readonly bundleBytes: number,
  ) {}
  async get(hash: string, load: () => Promise<string>): Promise<string> {
    const existing = this.#entries.get(hash);
    if (existing !== undefined) {
      this.#entries.delete(hash);
      this.#entries.set(hash, existing);
      return existing;
    }
    const pending = this.#loading.get(hash);
    if (pending) return pending;
    const loading = (async () => {
      const source = await load();
      const size = Buffer.byteLength(source);
      if (size > this.bundleBytes || bundleHash(source) !== hash) throw new Error("runner_invalid_bundle");
      if (size <= this.maxBytes) {
        while (this.#bytes + size > this.maxBytes) {
          const oldest = this.#entries.entries().next().value;
          if (!oldest) break;
          this.#entries.delete(oldest[0]);
          this.#bytes -= Buffer.byteLength(oldest[1]);
        }
        this.#entries.set(hash, source);
        this.#bytes += size;
      }
      return source;
    })();
    this.#loading.set(hash, loading);
    try {
      return await loading;
    } finally {
      this.#loading.delete(hash);
    }
  }
}
