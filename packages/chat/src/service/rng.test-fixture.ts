/** Seeded PRNG (mulberry32), as in the V5 spike; fast-check is not in the catalog. */
export const rng = (seed: number) => {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  return { next, int, pick: <T>(items: readonly T[]): T | undefined => (items.length ? items[int(items.length)] : undefined) };
};
