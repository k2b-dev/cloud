/**
 * Caller addresses for requests that pass per-IP rate limits.
 *
 * Rate-limit counters live in the shared test Valkey, which every test file,
 * every test process, and every concurrent local run reach. A small pool of
 * fake addresses therefore lets unrelated tests spend each other's budget: two
 * files that post to a once-per-minute route from the same address within a
 * minute see 429. Each address is fresh instead: the IPv6 documentation prefix
 * `2001:db8::/32` with 96 random bits.
 */

/** A documentation address that no other request, test file, or test run uses. */
export const uniqueCallerAddress = (): string =>
  ["2001", "db8", ...Array.from(crypto.getRandomValues(new Uint16Array(6)), (group) => group.toString(16))].join(":");
