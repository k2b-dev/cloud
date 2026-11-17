import { expect, spyOn, test } from "bun:test";
import { compileOutputRedaction, type OutputRedactionPending, redactOutput } from "./output-redaction";
import { secretEchoReplacements } from "./secret-echo";

const line = (text: string) => ({ kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log" as const, text });
const value = 'abcdefgh /+"value';
const replacements = secretEchoReplacements([{ name: "TOKEN", value, sent: `Bearer ${value}` }]);
for (const spelling of replacements.keys()) {
  for (const boundary of ["line", "batch"] as const) {
    test(`harden output redaction at ${boundary} boundaries for ${Buffer.from(spelling).toString("hex")}`, () => {
      const redactor = compileOutputRedaction(replacements);
      const middle = Math.floor(spelling.length / 2);
      const left = spelling.slice(0, middle),
        right = spelling.slice(middle);
      const first = redactOutput([line(left)], redactor);
      expect(first.entries.flatMap((line) => line.text)).toEqual([]);
      expect(first.pending!.text.length).toBeLessThan(redactor.longest);
      const result =
        boundary === "batch" ? redactOutput([line(right)], redactor, first.pending) : redactOutput([line(left), line(right)], redactor);
      const finished = redactOutput([], redactor, result.pending, true);
      const parts = [...result.entries, ...finished.entries].flatMap((line) => line.text);
      expect(parts.filter((part) => part.type === "secret")).toEqual([{ type: "secret", name: "TOKEN" }]);
      expect(parts.filter((part) => part.type === "text")).toEqual([]);
    });
  }
}
test("harden unfinished output fragments at finalization and keep the pending suffix bounded", () => {
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  let pending: OutputRedactionPending = null;
  for (const text of ["ab", "cd", "ef"]) {
    const result = redactOutput([line(text)], redactor, pending);
    expect(result.entries.flatMap((line) => line.text)).toEqual([]);
    expect(result.pending!.text.length).toBeLessThan(redactor.longest);
    pending = result.pending;
  }
  expect(redactOutput([], redactor, pending, true).entries).toEqual([
    { kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "secret", name: "TOKEN" }] },
  ]);
});
test("harden longest-match handling while releasing resolved ordinary text", () => {
  const redactor = compileOutputRedaction(
    new Map([
      ["abc", "[secret:SHORT]"],
      ["abcdef", "[secret:LONG]"],
    ]),
  );
  const first = redactOutput([line("prefix abc")], redactor);
  expect(first.entries).toEqual([
    { kind: "log" as const, at: "2030-01-02T00:00:00.000Z", level: "log", text: [{ type: "text", text: "prefix " }] },
  ]);
  expect(redactOutput([line("def tail")], redactor, first.pending).entries.flatMap((line) => line.text)).toEqual([
    { type: "secret", name: "LONG" },
    { type: "text", text: " tail" },
  ]);
  const mismatch = redactOutput([line("ab"), line("x")], redactor);
  expect(mismatch.pending).toBeNull();
  expect(mismatch.entries.map((line) => line.text)).toEqual([[{ type: "text", text: "ab" }], [{ type: "text", text: "x" }]]);
});

for (const boundary of ["line", "batch"] as const) {
  test(`harden Unicode output continuity at ${boundary} boundaries`, () => {
    const redactor = compileOutputRedaction(new Map([["ab😀cd", "[secret:TOKEN]"]]));
    const value = "ab😀cd";
    const left = line(value.slice(0, 3));
    const right = line(value.slice(3));
    const first = redactOutput([left], redactor);
    expect(first.entries.flatMap((line) => line.text)).toEqual([]);
    const result = boundary === "batch" ? redactOutput([right], redactor, first.pending) : redactOutput([left, right], redactor);
    expect(result.entries.flatMap((line) => line.text)).toEqual([{ type: "secret", name: "TOKEN" }]);
    expect(result.pending).toBeNull();
  });
}

test("deferred structured entries retain their original kind, level and timestamp", () => {
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const first = { ...line("abcd"), level: "error" as const };
  const second = { ...line("efgh tail"), at: "2030-01-02T00:00:01.000Z", level: "warn" as const };
  const pending = redactOutput([first], redactor).pending;
  const result = redactOutput([second], redactor, pending);
  expect(result.entries).toEqual([
    { kind: first.kind, level: first.level, at: first.at, text: [{ type: "secret", name: "TOKEN" }] },
    { kind: second.kind, level: second.level, at: second.at, text: [{ type: "text", text: " tail" }] },
  ]);
  expect(redactOutput([], redactor, pending, true).entries).toEqual([
    { kind: first.kind, level: first.level, at: first.at, text: [{ type: "secret", name: "TOKEN" }] },
  ]);
});

for (const boundary of ["batch", "following fragments"] as const) {
  test(`harden pending output when loss precedes ${boundary}`, () => {
    const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
    const accepted = redactOutput([line("abcd")], redactor);
    expect(accepted.entries.flatMap((entry) => entry.text)).toEqual([]);
    const lost = redactOutput(boundary === "batch" ? [line("normal")] : [], redactor, accepted.pending, false, { lost: true, skip: 0 });
    expect(lost.entries.flatMap((entry) => entry.text)).toEqual([{ type: "secret", name: "TOKEN" }]);
    expect(lost.pending).toBeNull();
    expect(lost.skip).toBe(redactor.longest - 1);
    // The missing continuation may be inside the reported batch or between it
    // and later fragments. Keep the conservative suffix across both boundaries.
    const following = redactOutput([line("gh")], redactor, lost.pending, false, { lost: false, skip: lost.skip });
    expect(following.entries).toEqual([]);
    expect(following.dropped.lines).toBe(1);
    const ordinary = redactOutput([line("normal")], redactor, following.pending, false, { lost: false, skip: following.skip });
    expect(ordinary.entries).toEqual([]);
    expect(ordinary.skip).toBe(0);
    expect(ordinary.dropped.bytes).toBe(Buffer.byteLength(JSON.stringify(line("normal"))));
    const restored = redactOutput([line("later")], redactor, ordinary.pending, false, { lost: false, skip: ordinary.skip });
    expect(restored.entries.flatMap((entry) => entry.text)).toEqual([{ type: "text", text: "later" }]);
  });
}
for (const spelling of replacements.keys()) {
  test(`harden deferred encoded output across a gap for ${Buffer.from(spelling).toString("hex")}`, () => {
    const redactor = compileOutputRedaction(replacements);
    const middle = Math.floor(spelling.length / 2);
    const accepted = redactOutput([line(spelling.slice(0, middle))], redactor);
    const lost = redactOutput([line(spelling.slice(middle)), line("ordinary")], redactor, accepted.pending, false, { lost: true, skip: 0 });
    expect(lost.entries.flatMap((entry) => entry.text)).toEqual([{ type: "secret", name: "TOKEN" }]);
    expect(lost.dropped.lines).toBe(2);
    const following = redactOutput([line(".".repeat(redactor.longest))], redactor, lost.pending, false, { lost: false, skip: lost.skip });
    expect(following.entries).toEqual([]);
    expect(following.skip).toBe(0);
  });
}

test("harden repetitive prefix matching with a deterministic linear transition bound", () => {
  const redactor = compileOutputRedaction(new Map([["a".repeat(6000) + "b", "[secret:TOKEN]"]]));
  const nodes = [redactor.root];
  for (let index = 0; index < nodes.length; index++) nodes.push(...nodes[index]!.next.values());
  let comparisons = 0;
  const lookups = nodes.map((node) => {
    const get = node.next.get.bind(node.next);
    return spyOn(node.next, "get").mockImplementation((char) => {
      comparisons++;
      return get(char);
    });
  });
  try {
    const text = "a".repeat(10 * 1024);
    const result = redactOutput([line(text)], redactor);
    expect(comparisons).toBeGreaterThanOrEqual(text.length);
    expect(comparisons).toBeLessThanOrEqual(2 * text.length);
    expect(result.pending?.text.length).toBeLessThan(redactor.longest);
  } finally {
    for (const lookup of lookups) lookup.mockRestore();
  }
});

test("harden failure suffixes and overlapping matches without releasing covered text", () => {
  const redactor = compileOutputRedaction(
    new Map([
      ["abcd", "[secret:FIRST]"],
      ["cdef", "[secret:SECOND]"],
      ["abz", "[secret:THIRD]"],
      ["bz", "[secret:FOURTH]"],
    ]),
  );
  expect(redactOutput([line("abcdef abz bz!")], redactor, null, true).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "secret", name: "FIRST" },
    { type: "text", text: " " },
    { type: "secret", name: "THIRD" },
    { type: "text", text: " " },
    { type: "secret", name: "FOURTH" },
    { type: "text", text: "!" },
  ]);
});

test("harden pending failure suffixes after a completed match", () => {
  const redactor = compileOutputRedaction(
    new Map([
      ["abc", "[secret:FIRST]"],
      ["bcdefghi", "[secret:SECOND]"],
      ["ghijk", "[secret:THIRD]"],
    ]),
  );
  const first = redactOutput([line("abcdefgh")], redactor);
  expect(first.entries.flatMap((entry) => entry.text)).toEqual([]);
  expect(first.pending?.text).toBe("bcdefgh");
  expect(first.pending!.text.length).toBeLessThan(redactor.longest);
  const second = redactOutput([line("i")], redactor, first.pending);
  expect(second.entries.flatMap((entry) => entry.text)).toEqual([]);
  expect(second.pending?.text).toBe("ghi");
  expect(redactOutput([line("jk!")], redactor, second.pending).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "secret", name: "FIRST" },
    { type: "text", text: "!" },
  ]);
});

for (const spelling of replacements.keys()) {
  for (const boundary of ["line", "batch"] as const) {
    test(`harden suppressed end candidates at ${boundary} boundaries for ${Buffer.from(spelling).toString("hex")}`, () => {
      const redactor = compileOutputRedaction(replacements);
      const middle = Math.floor(spelling.length / 2);
      const lost = redactOutput([], redactor, null, false, { lost: true, skip: 0 });
      const muted = line(".".repeat(redactor.longest) + spelling.slice(0, middle));
      const continuation = line(spelling.slice(middle) + "!");
      const first = redactOutput([muted], redactor, lost.pending, false, { lost: false, skip: lost.skip });
      expect(first.entries).toEqual([]);
      expect(first.skip).toBe(0);
      expect(first.dropped.lines).toBe(1);
      expect(first.dropped.bytes).toBe(Buffer.byteLength(JSON.stringify(muted)));
      expect(first.pending?.text).toBe(spelling.slice(0, middle));
      const result = boundary === "batch"
        ? redactOutput([continuation], redactor, JSON.parse(JSON.stringify(first.pending)), false, { lost: false, skip: first.skip })
        : redactOutput([muted, continuation], redactor, lost.pending, false, { lost: false, skip: lost.skip });
      expect(result.entries.flatMap((entry) => entry.text)).toEqual([
        { type: "secret", name: "TOKEN" },
        { type: "text", text: "!" },
      ]);
      expect(result.pending).toBeNull();
    });
  }
}

test("harden suppressed candidates through mismatch, finalization and repeated gaps", () => {
  const redactor = compileOutputRedaction(new Map([["abcdefgh", "[secret:TOKEN]"]]));
  const muted = redactOutput([line("ab")], redactor, null, false, { lost: false, skip: 1 });
  expect(muted.pending?.hidden).toBe(2);
  expect(redactOutput([line("x!")], redactor, muted.pending).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "text", text: "x!" },
  ]);
  expect(redactOutput([], redactor, muted.pending, true).entries).toEqual([]);
  expect(redactOutput([], redactor, muted.pending, false, { lost: true, skip: 0 }).entries).toEqual([]);
  const lost = redactOutput([line(".".repeat(redactor.longest) + "ab")], redactor, null, false, { lost: true, skip: 0 });
  const next = redactOutput([line("cd")], redactor, lost.pending, false, { lost: false, skip: lost.skip });
  expect(next.pending?.text).toBe("abcd");
  expect(next.pending?.hidden).toBe(4);
  const last = redactOutput([line("efgh!")], redactor, next.pending, false, { lost: false, skip: next.skip });
  expect(last.entries).toEqual([]);
  expect(last.skip).toBe(0);
  expect(redactOutput([line("ordinary!")], redactor, last.pending).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "text", text: "ordinary!" },
  ]);
});

for (const fragments of [["abc", "defghi!"], ["ab", "c", "def", "ghi!"], ["abc", "x!"], ["abc", ""]]) {
  test(`harden overlapping deferred areas across ${JSON.stringify(fragments)}`, () => {
    const redactor = compileOutputRedaction(new Map([["abc", "[secret:FIRST]"], ["bcdefghi", "[secret:SECOND]"]]));
    let pending: OutputRedactionPending = null;
    const parts = [];
    for (const text of fragments) {
      const result = redactOutput([line(text)], redactor, pending);
      parts.push(...result.entries.flatMap((entry) => entry.text));
      pending = result.pending;
      if (pending) expect(pending.text.length).toBeLessThan(redactor.longest);
    }
    parts.push(...redactOutput([], redactor, pending, true).entries.flatMap((entry) => entry.text));
    expect(parts).toEqual([
      { type: "secret", name: "FIRST" },
      ...(fragments.at(-1) === "x!" ? [{ type: "text", text: "x!" }] : fragments.at(-1) ? [{ type: "text", text: "!" }] : []),
    ]);
  });
}

test("harden bounded deferred areas through repetitive overlapping input", () => {
  const redactor = compileOutputRedaction(new Map([["aaa", "[secret:TOKEN]"]]));
  let pending: OutputRedactionPending = null;
  for (let index = 0; index < 4; index++) {
    const result = redactOutput([line("a".repeat(1024))], redactor, pending);
    expect(result.entries.flatMap((entry) => entry.text)).toEqual([]);
    expect(result.pending!.text.length).toBeLessThan(redactor.longest);
    pending = result.pending;
  }
  expect(redactOutput([line("!")], redactor, pending).entries.flatMap((entry) => entry.text)).toEqual([
    { type: "secret", name: "TOKEN" },
    { type: "text", text: "!" },
  ]);
});
