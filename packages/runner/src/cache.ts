/** SHA-256 of the exact UTF-8 module delivered by Core. */
export const bundleHash = (source: string): string => new Bun.CryptoHasher("sha256").update(source).digest("hex");

/** Replica-local LRU only. Active loads are bounded by free slots; no filesystem or shared cache. */
export class BundleCache {
  #bytes = 0;
  #entries = new Map<string, string>();
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
    // A cold download belongs to one lease and cancellation signal. Sharing
    // its promise would let one fenced attempt fail another valid attempt.
    const source = await load();
    const size = Buffer.byteLength(source);
    if (size > this.bundleBytes || bundleHash(source) !== hash) throw new Error("runner_invalid_bundle");
    if (size <= this.maxBytes && !this.#entries.has(hash)) {
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
  }
}
