import { describe, it, expect } from "bun:test";
import { match, filter, segments, distance, closest, fuzzy } from "./fuzzy";

// =====================================================================
// match — basic correctness
// =====================================================================

describe("fuzzy.match — basics", () => {
  it("returns null for non-subsequence", () => {
    expect(match("xyz", "userDashboard")).toBeNull();
  });

  it("returns null when query is longer than target", () => {
    expect(match("longquery", "abc")).toBeNull();
  });

  it("returns null when target is shorter than query", () => {
    expect(match("ab", "a")).toBeNull();
  });

  it("returns null for empty target with non-empty query", () => {
    expect(match("a", "")).toBeNull();
  });

  it("returns score 0 and empty ranges for empty query", () => {
    expect(match("", "userDashboard")).toEqual({ score: 0, ranges: [] });
    expect(match("", "")).toEqual({ score: 0, ranges: [] });
  });

  it("matches a single char", () => {
    const r = match("u", "userDashboard");
    expect(r).not.toBeNull();
    expect(r!.ranges).toEqual([[0, 1]]);
  });

  it("matches an exact string with one collapsed range", () => {
    const r = match("user", "user");
    expect(r).not.toBeNull();
    expect(r!.ranges).toEqual([[0, 4]]);
  });

  it("collapses contiguous matches into a single range", () => {
    const r = match("user", "username");
    expect(r).not.toBeNull();
    expect(r!.ranges).toEqual([[0, 4]]);
  });

  it("returns multiple ranges for non-contiguous subsequences", () => {
    const r = match("udh", "userDashboard");
    expect(r).not.toBeNull();
    expect(r!.ranges).toEqual([
      [0, 1],
      [4, 5],
      [7, 8],
    ]);
  });

  it("uses [start, endExclusive] half-open ranges", () => {
    const r = match("user", "user")!;
    const [start, end] = r.ranges[0]!;
    expect("user".slice(start, end)).toBe("user");
  });

  it("ranges are sorted ascending and non-overlapping", () => {
    const r = match("aeio", "abcdefghijklmnop")!;
    expect(r).not.toBeNull();
    for (let i = 1; i < r.ranges.length; i++) {
      expect(r.ranges[i]![0]).toBeGreaterThanOrEqual(r.ranges[i - 1]![1]);
    }
  });
});

// =====================================================================
// match — case sensitivity
// =====================================================================

describe("fuzzy.match — case sensitivity", () => {
  it("is case-insensitive by default", () => {
    expect(match("USR", "user")).not.toBeNull();
    expect(match("user", "USER")).not.toBeNull();
    expect(match("UsEr", "uSeR")).not.toBeNull();
  });

  it("is strict when caseSensitive: true", () => {
    expect(match("USR", "user", { caseSensitive: true })).toBeNull();
    expect(match("usr", "USER", { caseSensitive: true })).toBeNull();
  });

  it("matches identical-case input under caseSensitive", () => {
    expect(
      match("user", "userDashboard", { caseSensitive: true }),
    ).not.toBeNull();
  });

  it("rewards case-matching characters with a higher score", () => {
    const matched = match("usr", "user")!;
    const mismatched = match("USR", "user")!;
    expect(matched.score).toBeGreaterThan(mismatched.score);
  });
});

// =====================================================================
// match — DP optimality (where greedy would fail)
// =====================================================================

describe("fuzzy.match — DP optimality", () => {
  it("DP beats greedy when a contiguous tail outscores an earlier spread", () => {
    // 'abc' in 'axxbxxbcxxc':
    //   greedy LtoR → a@0, b@3, c@7 (two big gaps)
    //   optimal DP → a@0, b@6, c@7 (one big gap, then contiguous bc)
    // The contiguous bonus + smaller second gap wins.
    const r = match("abc", "axxbxxbcxxc")!;
    const positions = r.ranges.flatMap(([s, e]) =>
      Array.from({ length: e - s }, (_, i) => s + i),
    );
    expect(positions[0]).toBe(0); // a@0 (FIRST_CHAR bonus is too valuable to skip)
    // The last two query chars (b, c) must be adjacent in the target.
    expect(positions[2]! - positions[1]!).toBe(1);
  });

  it("picks word-boundary matches when they outscore prefix-only matches", () => {
    // "fb" in "foo-bar": [0,4] (boundary at 'b') should beat naive [0,1].
    const r = match("fb", "foo-bar")!;
    // 'b' is at index 4 (after the hyphen → boundary).
    expect(r.ranges.flat()).toContain(4);
  });

  it("picks camelCase boundary matches", () => {
    // "ud" in "userDashboard" should match u@0 + D@4 (camel boundary).
    const r = match("ud", "userDashboard")!;
    expect(r.ranges).toEqual([
      [0, 1],
      [4, 5],
    ]);
  });
});

// =====================================================================
// match — scoring heuristic expectations
// =====================================================================

describe("fuzzy.match — scoring heuristic", () => {
  it("scores prefix matches higher than mid-word matches", () => {
    const prefix = match("us", "userDashboard")!;
    const mid = match("us", "Object useRef")!;
    expect(prefix.score).toBeGreaterThan(mid.score);
  });

  it("scores word-boundary matches higher than mid-word matches", () => {
    const boundary = match("u", "foo-user")!;
    const mid = match("u", "configure")!;
    expect(boundary.score).toBeGreaterThan(mid.score);
  });

  it("scores contiguous matches higher than scattered matches", () => {
    const contig = match("user", "username")!;
    const scattered = match("user", "u_s_e_r_x")!;
    expect(contig.score).toBeGreaterThan(scattered.score);
  });

  it("rewards every-char-on-boundary over a fewer-boundaries match", () => {
    // 'fbb' is the perfect 3-word-initial abbreviation of "foo-bar-baz".
    // In "foobarbaz" only 'f' is a boundary char; the two b's are mid-word.
    const allBoundaries = match("fbb", "foo-bar-baz")!;
    const oneBoundary = match("fbb", "foobarbaz")!;
    expect(allBoundaries.score).toBeGreaterThan(oneBoundary.score);
  });

  it("rewards camelCase initial-letter abbreviation", () => {
    // Two boundaries (f, B) should beat one boundary (f only).
    const camel = match("fb", "fooBar")!;
    const flat = match("fb", "fubar")!;
    expect(camel.score).toBeGreaterThan(flat.score);
  });

  it("treats kebab/snake/space separators as word boundaries", () => {
    const kebab = match("fb", "foo-bar")!;
    const snake = match("fb", "foo_bar")!;
    const space = match("fb", "foo bar")!;
    const dot = match("fb", "foo.bar")!;
    // All four should land on the boundary 'b'.
    [kebab, snake, space, dot].forEach((r) => {
      expect(r.ranges.flat()).toContain(4);
    });
  });

  it("does not flag false camelCase boundaries (UPPER → upper)", () => {
    // In 'XMLParser', the 'P' at position 3 IS a boundary (upper-after-upper-then-lower
    // is debatable, but our impl treats only lower→Upper or digit→Upper as a camel boundary).
    // Confirm 'm' inside 'XML' is NOT flagged as a boundary.
    const inside = match("m", "XMLParser")!;
    const start = match("X", "XMLParser")!;
    expect(start.score).toBeGreaterThan(inside.score);
  });
});

// =====================================================================
// match — special inputs
// =====================================================================

describe("fuzzy.match — special inputs", () => {
  it("treats regex meta-chars as plain characters", () => {
    expect(match(".*", "a.*b")).not.toBeNull();
    expect(match(".*", "abcdef")).toBeNull();
  });

  it("matches digits and word chars correctly", () => {
    const r = match("123", "v1.2.3")!;
    expect(r.ranges).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
  });

  it("handles repeated characters in query", () => {
    const r = match("aaa", "aXaXaXa")!;
    expect(r.ranges.length).toBeGreaterThan(0);
  });

  it("handles repeated characters greedy-trap (aab in aaab)", () => {
    // Naive forward-greedy might pick [0,1,3]. Either [0,2,3] or [1,2,3] is
    // acceptable as long as it's a valid subsequence; verify just that the
    // last char is 'b' and the result is 3 positions long.
    const r = match("aab", "aaab")!;
    const flat = r.ranges.flatMap(([s, e]) => {
      const out: number[] = [];
      for (let k = s; k < e; k++) out.push(k);
      return out;
    });
    expect(flat).toHaveLength(3);
    expect(flat[2]).toBe(3); // 'b' is at index 3
  });

  it("handles unicode / non-ASCII characters as word chars", () => {
    const r = match("über", "über");
    expect(r).not.toBeNull();
  });

  it("does not crash on very long target", () => {
    const target = "a".repeat(1000) + "b";
    const r = match("ab", target);
    expect(r).not.toBeNull();
  });
});

// =====================================================================
// filter — basic behavior
// =====================================================================

describe("fuzzy.filter — strings", () => {
  it("returns hits sorted by score descending", () => {
    const items = ["userDashboard", "userHome", "logout", "configurator"];
    const hits = filter("us", items);
    expect(hits.length).toBeGreaterThan(0);
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it("drops items without a match", () => {
    const hits = filter("xyz", ["userDashboard", "logout", "xyzCorp"]);
    expect(hits.map((h) => h.target)).toEqual(["xyzCorp"]);
  });

  it("returns empty array when no items match", () => {
    expect(filter("zzz", ["alpha", "beta", "gamma"])).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(filter("anything", [])).toEqual([]);
  });

  it("returns all items with score 0 for empty query", () => {
    const items = ["a", "b", "c"];
    const hits = filter("", items);
    expect(hits.map((h) => h.item)).toEqual(items);
    expect(hits.every((h) => h.score === 0)).toBe(true);
    expect(hits.every((h) => h.ranges.length === 0)).toBe(true);
  });

  it("respects limit", () => {
    const hits = filter("a", ["alpha", "abacus", "atlas", "beta", "gamma"], {
      limit: 2,
    });
    expect(hits.length).toBe(2);
  });

  it("limit larger than result count returns all hits", () => {
    const hits = filter("a", ["alpha", "atlas"], { limit: 99 });
    expect(hits.length).toBe(2);
  });

  it("populates target = item when no key accessor is given", () => {
    const hits = filter("us", ["userDashboard"]);
    expect(hits[0]!.target).toBe("userDashboard");
    expect(hits[0]!.item).toBe("userDashboard");
  });
});

// =====================================================================
// filter — with key accessor
// =====================================================================

describe("fuzzy.filter — with key accessor", () => {
  type User = { id: number; name: string };

  it("matches against the keyed string", () => {
    const users: User[] = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
      { id: 3, name: "Alex" },
    ];
    const hits = filter("al", users, { key: (u) => u.name });
    expect(hits.map((h) => h.item.id).sort()).toEqual([1, 3]);
    expect(hits[0]!.target).toMatch(/^A/);
  });

  it("preserves original item reference", () => {
    const users: User[] = [{ id: 1, name: "Alice" }];
    const hits = filter("al", users, { key: (u) => u.name });
    expect(hits[0]!.item).toBe(users[0]!);
  });
});

// =====================================================================
// filter — case sensitivity
// =====================================================================

describe("fuzzy.filter — case sensitivity", () => {
  it("is case-insensitive by default", () => {
    const hits = filter("USR", ["userDashboard", "noMatch"]);
    expect(hits.map((h) => h.target)).toEqual(["userDashboard"]);
  });

  it("is strict when caseSensitive: true", () => {
    const hits = filter("USR", ["userDashboard", "USERnames"], {
      caseSensitive: true,
    });
    expect(hits.map((h) => h.target)).toEqual(["USERnames"]);
  });
});

// =====================================================================
// filter — sort stability
// =====================================================================

describe("fuzzy.filter — sort stability", () => {
  it("preserves original order for equal scores (empty query)", () => {
    const items = Array.from({ length: 50 }, (_, i) => `item-${i}`);
    const hits = filter("", items);
    expect(hits.map((h) => h.item)).toEqual(items);
  });
});

// =====================================================================
// segments — splitting
// =====================================================================

describe("fuzzy.segments", () => {
  it("returns empty array for empty target with no ranges", () => {
    expect(segments("", [])).toEqual([]);
  });

  it("returns whole text as a single non-match segment when ranges are empty", () => {
    expect(segments("hello", [])).toEqual([{ text: "hello", match: false }]);
  });

  it("returns a single match segment when one range covers everything", () => {
    expect(segments("user", [[0, 4]])).toEqual([{ text: "user", match: true }]);
  });

  it("splits a single mid-target match", () => {
    expect(segments("hello world", [[6, 11]])).toEqual([
      { text: "hello ", match: false },
      { text: "world", match: true },
    ]);
  });

  it("splits a leading match", () => {
    expect(segments("foobar", [[0, 3]])).toEqual([
      { text: "foo", match: true },
      { text: "bar", match: false },
    ]);
  });

  it("splits a trailing match", () => {
    expect(segments("foobar", [[3, 6]])).toEqual([
      { text: "foo", match: false },
      { text: "bar", match: true },
    ]);
  });

  it("splits multiple ranges into alternating segments", () => {
    expect(
      segments("userDashboard", [
        [0, 1],
        [4, 5],
        [7, 8],
      ]),
    ).toEqual([
      { text: "u", match: true },
      { text: "ser", match: false },
      { text: "D", match: true },
      { text: "as", match: false },
      { text: "h", match: true },
      { text: "board", match: false },
    ]);
  });

  it("recombines segments back into the original target", () => {
    const r = match("udh", "userDashboard")!;
    const segs = segments("userDashboard", r.ranges);
    expect(segs.map((s) => s.text).join("")).toBe("userDashboard");
  });

  it("integration: match → segments produces alternating runs", () => {
    const r = match("user", "username")!;
    const segs = segments("username", r.ranges);
    expect(segs).toEqual([
      { text: "user", match: true },
      { text: "name", match: false },
    ]);
  });
});

// =====================================================================
// distance — Levenshtein
// =====================================================================

describe("fuzzy.distance", () => {
  it("returns 0 for identical strings", () => {
    expect(distance("abc", "abc")).toBe(0);
    expect(distance("", "")).toBe(0);
  });

  it("returns the length when one side is empty", () => {
    expect(distance("", "abc")).toBe(3);
    expect(distance("abc", "")).toBe(3);
  });

  it("counts a single substitution as 1", () => {
    expect(distance("abc", "abd")).toBe(1);
  });

  it("counts a single insertion as 1", () => {
    expect(distance("abc", "abcd")).toBe(1);
  });

  it("counts a single deletion as 1", () => {
    expect(distance("abcd", "abc")).toBe(1);
  });

  it("counts transposition as 2 (no Damerau bonus)", () => {
    expect(distance("abc", "acb")).toBe(2);
  });

  it("counts fully different equal-length strings as their length", () => {
    expect(distance("abc", "xyz")).toBe(3);
  });

  it("matches well-known reference values", () => {
    expect(distance("kitten", "sitting")).toBe(3);
    expect(distance("flaw", "lawn")).toBe(2);
    expect(distance("intention", "execution")).toBe(5);
  });

  it("is symmetric", () => {
    expect(distance("hello", "world")).toBe(distance("world", "hello"));
    expect(distance("kitten", "sitting")).toBe(distance("sitting", "kitten"));
  });

  it("is case-sensitive (no implicit fold)", () => {
    expect(distance("HELLO", "hello")).toBe(5);
  });
});

// =====================================================================
// closest — Levenshtein-based did-you-mean
// =====================================================================

describe("fuzzy.closest", () => {
  it("returns null for empty choices", () => {
    expect(closest("anything", [])).toBeNull();
  });

  it("returns the best match below the default Infinity threshold", () => {
    const r = closest("hellp", ["hello", "help", "world"]);
    expect(r).toEqual({ value: "hello", distance: 1, similarity: 0.8 });
  });

  it("returns null when nothing falls within maxDistance", () => {
    expect(
      closest("zzz", ["hello", "help", "world"], { maxDistance: 1 }),
    ).toBeNull();
  });

  it("includes the boundary case (distance == maxDistance)", () => {
    const r = closest("hellp", ["hello"], { maxDistance: 1 });
    expect(r?.value).toBe("hello");
  });

  it("preserves original casing in the returned value", () => {
    const r = closest("Hellp", ["Hello", "World"]);
    expect(r?.value).toBe("Hello");
  });

  it("is case-insensitive by default for matching", () => {
    const r = closest("HELLO", ["hello"]);
    expect(r).toEqual({ value: "hello", distance: 0, similarity: 1 });
  });

  it("respects caseSensitive: true", () => {
    const r = closest("HELLO", ["hello"], { caseSensitive: true });
    expect(r?.distance).toBe(5);
    expect(r?.similarity).toBe(0);
  });

  it("returns the first of several equal-distance candidates", () => {
    const r = closest("xxx", ["abc", "def"]);
    expect(r?.value).toBe("abc");
  });

  it("computes similarity as 1 - distance / maxLen", () => {
    const r = closest("hello", ["help"]);
    // distance("hello", "help") = 2, maxLen = 5, similarity = 0.6
    expect(r?.distance).toBe(2);
    expect(r?.similarity).toBeCloseTo(0.6, 5);
  });

  it("returns similarity 1 for an exact match", () => {
    const r = closest("hello", ["hello", "world"]);
    expect(r?.distance).toBe(0);
    expect(r?.similarity).toBe(1);
  });

  it("handles single-choice list", () => {
    const r = closest("foo", ["bar"]);
    expect(r?.value).toBe("bar");
    expect(r?.distance).toBe(3);
  });
});

// =====================================================================
// namespace export
// =====================================================================

describe("fuzzy namespace", () => {
  it("re-exports all public functions", () => {
    expect(fuzzy.match).toBe(match);
    expect(fuzzy.filter).toBe(filter);
    expect(fuzzy.segments).toBe(segments);
    expect(fuzzy.distance).toBe(distance);
    expect(fuzzy.closest).toBe(closest);
  });
});

// =====================================================================
// Performance benchmarks
// =====================================================================
//
// These are deliberately generous thresholds — they catch order-of-magnitude
// regressions, not micro-perf changes. Tightening them risks flaky CI.

describe("fuzzy — performance", () => {
  it("match: 1000 calls on a 50-char target finish under 100ms", () => {
    const target = "userDashboardControllerComponentRenderer.tsx";
    const start = performance.now();
    for (let i = 0; i < 1000; i++) match("udcr", target);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("match: handles 1000-char target under 5ms per call", () => {
    const target = "a".repeat(500) + "needle" + "b".repeat(494);
    const start = performance.now();
    for (let i = 0; i < 50; i++) match("ndle", target);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250); // 50 calls × 5ms
  });

  it("filter: 10k items × ~30 chars finish under 250ms", () => {
    const items = Array.from(
      { length: 10_000 },
      (_, i) => `module-${i}-foo-bar-baz-quux-frob`,
    );
    const start = performance.now();
    const hits = filter("mfbq", items, { limit: 50 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(250);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("filter: early subsequence rejection is cheap on no-match haystack", () => {
    // All items lack 'z'; the pre-scan should bail out instantly.
    const items = Array.from(
      { length: 100_000 },
      (_, i) => `item-${i}-foo-bar-baz`, // contains 'z' but not 'q'
    );
    const start = performance.now();
    const hits = filter("zzzqqq", items);
    const elapsed = performance.now() - start;
    expect(hits).toEqual([]);
    expect(elapsed).toBeLessThan(200);
  });

  it("distance: 10k pairs of ~20-char strings under 200ms", () => {
    const pairs = Array.from({ length: 10_000 }, (_, i) => [
      `kitten-${i}-foo`,
      `sitting-${i}-bar`,
    ]);
    const start = performance.now();
    for (const [a, b] of pairs) distance(a!, b!);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });

  it("closest: 10k choices under 200ms", () => {
    const choices = Array.from({ length: 10_000 }, (_, i) => `option-${i}`);
    const start = performance.now();
    closest("optn-42", choices);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});

// =====================================================================
// Regression: defensive guards
// =====================================================================

describe("filter — non-string items without key", () => {
  it("throws a clear TypeError when items aren't strings and no key is given", () => {
    expect(() =>
      filter("a", [1, 2, 3] as unknown as string[], {}),
    ).toThrow(TypeError);
  });

  it("works correctly with explicit key accessor", () => {
    const items = [{ name: "alpha" }, { name: "beta" }, { name: "atlas" }];
    const hits = filter("a", items, { key: (i) => i.name });
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("match — non-ASCII case folding", () => {
  it("matches accented uppercase against accented lowercase", () => {
    // The c+32 trick only worked for A-Z; "É" → "é" requires toLowerCase.
    const r = match("é", "École");
    expect(r).not.toBeNull();
  });
});
